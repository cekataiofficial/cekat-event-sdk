package ai.cekat.events.transport;

import java.io.ByteArrayOutputStream;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Default transport over {@link HttpClient}. The per-attempt timeout covers connecting, sending, the response headers,
 * and the body; at most 65,537 body bytes are read. The default client never follows redirects, and the JDK client
 * never silently resends a POST on a stale connection.
 */
public final class JdkHttpTransport implements HttpTransport {
    private final HttpClient client;

    /** Creates a transport with a new client that does not follow redirects. */
    public JdkHttpTransport() {
        this(HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build());
    }

    /**
     * Creates a transport over a caller-owned client. The client is not modified; configure it not to follow redirects.
     *
     * @param client HTTP client
     */
    public JdkHttpTransport(HttpClient client) {
        this.client = client;
    }

    @Override
    public TransportResponse execute(TransportRequest request) throws TransportFailureException, InterruptedException {
        long deadline = System.nanoTime() + request.timeout().toNanos();
        HttpRequest.Builder builder = HttpRequest.newBuilder(request.uri())
                .timeout(request.timeout())
                .POST(HttpRequest.BodyPublishers.ofByteArray(request.body()));
        request.headers().forEach(builder::header);

        AtomicReference<HttpResponse.ResponseInfo> head = new AtomicReference<>();
        AtomicReference<BoundedSubscriber> subscriber = new AtomicReference<>();
        CompletableFuture<HttpResponse<BoundedSubscriber>> future = client.sendAsync(builder.build(), info -> {
            BoundedSubscriber created = new BoundedSubscriber();
            subscriber.set(created);
            head.set(info);
            return created;
        });
        try {
            HttpResponse<BoundedSubscriber> response = future.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            return response.body().toResponse(response.statusCode(), response.headers().map(), null);
        } catch (InterruptedException interrupted) {
            future.cancel(true);
            throw interrupted;
        } catch (TimeoutException timeout) {
            future.cancel(true);
            return afterHeadersOrFail(head.get(), subscriber.get(), new TransportFailureException("attempt timed out after " + request.timeout()));
        } catch (ExecutionException failure) {
            Throwable cause = failure.getCause() == null ? failure : failure.getCause();
            return afterHeadersOrFail(head.get(), subscriber.get(), TransportFailureException.from(cause));
        }
    }

    private static TransportResponse afterHeadersOrFail(HttpResponse.ResponseInfo head, BoundedSubscriber subscriber,
            TransportFailureException failure) throws TransportFailureException {
        if (head == null || subscriber == null) {
            throw failure;
        }
        return subscriber.toResponse(head.statusCode(), head.headers().map(), subscriber.overflowed() ? null : failure);
    }

    /** Collects a bounded body prefix and cancels the download after the sentinel byte. */
    private static final class BoundedSubscriber implements HttpResponse.BodySubscriber<BoundedSubscriber> {
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private final CompletableFuture<BoundedSubscriber> result = new CompletableFuture<>();
        private volatile Flow.Subscription subscription;

        @Override
        public CompletionStage<BoundedSubscriber> getBody() {
            return result;
        }

        @Override
        public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            value.request(Long.MAX_VALUE);
        }

        @Override
        public synchronized void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                int room = TransportResponse.MAX_BODY_BYTES + 1 - bytes.size();
                int length = Math.min(room, buffer.remaining());
                if (length > 0) {
                    byte[] chunk = new byte[length];
                    buffer.get(chunk);
                    bytes.write(chunk, 0, length);
                }
            }
            if (overflowed()) {
                subscription.cancel();
                result.complete(this);
            }
        }

        @Override
        public void onError(Throwable throwable) {
            result.completeExceptionally(throwable);
        }

        @Override
        public void onComplete() {
            result.complete(this);
        }

        synchronized boolean overflowed() {
            return bytes.size() > TransportResponse.MAX_BODY_BYTES;
        }

        synchronized TransportResponse toResponse(int status, Map<String, List<String>> headers, Throwable failure) {
            byte[] observed = bytes.toByteArray();
            boolean truncated = observed.length > TransportResponse.MAX_BODY_BYTES;
            byte[] retained = truncated ? java.util.Arrays.copyOf(observed, TransportResponse.MAX_BODY_BYTES) : observed;
            return new TransportResponse(status, headers, retained, truncated, observed.length, failure);
        }
    }
}
