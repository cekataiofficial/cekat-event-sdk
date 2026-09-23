package ai.cekat.events;

import ai.cekat.events.error.ApiException;
import ai.cekat.events.error.ResponseDecodeException;
import ai.cekat.events.error.TransportException;
import ai.cekat.events.error.ValidationException;
import ai.cekat.events.internal.PayloadEncoder;
import ai.cekat.events.internal.ResponseDecoder;
import ai.cekat.events.internal.RetryPolicy;
import ai.cekat.events.transport.TransportFailureException;
import ai.cekat.events.transport.TransportRequest;
import ai.cekat.events.transport.TransportResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.OptionalLong;

/**
 * Submits Cekat events synchronously. Construct one client and reuse it; it is thread-safe.
 *
 * <p>Each method returns an {@link Acknowledgement} (accepted for asynchronous processing) or throws
 * {@link ValidationException} before any request, {@link ai.cekat.events.error.AuthenticationException} (401),
 * {@link ai.cekat.events.error.EventDefinitionNotFoundException} (404), {@link ApiException} for other non-200
 * responses, {@link ResponseDecodeException} for an invalid or unreadable 200, or {@link TransportException} when no
 * response was received. Retries may create duplicate events; every retry reuses the call's event ID. Interrupting the
 * calling thread stops the call with {@link InterruptedException}.
 */
public final class CekatClient {
    /** SDK version reported in the User-Agent header. */
    public static final String VERSION = "0.2.0";

    private final String accessToken;
    private final CekatClientOptions options;
    private final PayloadEncoder encoder;

    /**
     * Creates a client with default options.
     *
     * @param accessToken nonblank access token
     */
    public CekatClient(String accessToken) {
        this(accessToken, CekatClientOptions.defaults());
    }

    /**
     * Creates a client.
     *
     * @param accessToken nonblank access token
     * @param options client options
     */
    public CekatClient(String accessToken, CekatClientOptions options) {
        this(accessToken, options, new PayloadEncoder());
    }

    CekatClient(String accessToken, CekatClientOptions options, PayloadEncoder encoder) {
        if (accessToken == null || accessToken.isBlank()) {
            throw new ValidationException("access token must not be blank");
        }
        if (options == null) {
            throw new ValidationException("options must not be null");
        }
        this.accessToken = accessToken;
        this.options = options;
        this.encoder = encoder;
    }

    /**
     * Submits the common user_registration event.
     *
     * @param event event
     * @return acknowledgement
     * @throws InterruptedException when the calling thread is interrupted
     */
    public Acknowledgement userRegistration(Event event) throws InterruptedException {
        return track("user_registration", true, event);
    }

    /**
     * Submits the common user_login event.
     *
     * @param event event
     * @return acknowledgement
     * @throws InterruptedException when the calling thread is interrupted
     */
    public Acknowledgement userLogin(Event event) throws InterruptedException {
        return track("user_login", true, event);
    }

    /**
     * Submits the common order_created event.
     *
     * @param event event
     * @return acknowledgement
     * @throws InterruptedException when the calling thread is interrupted
     */
    public Acknowledgement orderCreated(Event event) throws InterruptedException {
        return track("order_created", true, event);
    }

    /**
     * Submits the common form_submitted event.
     *
     * @param event event
     * @return acknowledgement
     * @throws InterruptedException when the calling thread is interrupted
     */
    public Acknowledgement formSubmitted(Event event) throws InterruptedException {
        return track("form_submitted", true, event);
    }

    /**
     * Submits the common order_paid event. The finite {@code amount} and nonblank {@code currency} are sent as the
     * {@code amount} and {@code currency} properties; the event's properties must not already contain either key.
     *
     * @param amount finite amount, for example a {@link java.math.BigDecimal}
     * @param currency nonblank currency, not validated as a currency code
     * @param event event
     * @return acknowledgement
     * @throws InterruptedException when the calling thread is interrupted
     */
    public Acknowledgement orderPaid(Number amount, String currency, Event event) throws InterruptedException {
        return track("order_paid", true, PayloadEncoder.withOrderPaidProperties(amount, currency, event));
    }

    /**
     * Submits an event with a caller-provided key.
     *
     * @param eventKey nonblank event key
     * @param event event
     * @return acknowledgement
     * @throws InterruptedException when the calling thread is interrupted
     */
    public Acknowledgement customEvent(String eventKey, Event event) throws InterruptedException {
        return track(eventKey, false, event);
    }

    @Override
    public String toString() {
        return "CekatClient[baseUrl=" + options.baseUrl() + ", timeout=" + options.timeout() + ", retryCount=" + options.retryCount() + "]";
    }

    private Acknowledgement track(String eventKey, boolean isCommon, Event event) throws InterruptedException {
        // Encoded once so every retry sends the same event ID and timestamp.
        byte[] body = encoder.encode(eventKey, isCommon, event, VisitorContext.currentVisitorId().orElse(null));
        TransportRequest request = new TransportRequest(options.ingestUri(), Map.of(
                "Authorization", "Bearer " + accessToken,
                "Content-Type", "application/json",
                "User-Agent", "cekat-event-sdk-java/" + VERSION + " java/" + Runtime.version().feature()), body, options.timeout());

        int maximumAttempts = options.retryCount() + 1;
        for (int attempt = 1; ; attempt++) {
            if (Thread.interrupted()) {
                throw new InterruptedException("Cekat event submission interrupted");
            }
            TransportResponse response;
            try {
                response = options.transport().execute(request);
            } catch (TransportFailureException failure) {
                if (attempt >= maximumAttempts) {
                    throw new TransportException("Cekat API request failed before a response was received", attempt, failure);
                }
                backoff(attempt, OptionalLong.empty());
                continue;
            }

            // Retry is decided by status alone, even when the body read failed.
            if (attempt < maximumAttempts && RetryPolicy.isRetryableStatus(response.statusCode())) {
                OptionalLong retryAfter = RetryPolicy.parseRetryAfterMillis(response.header("Retry-After").orElse(null), Instant.now());
                if (retryAfter.isEmpty() || retryAfter.getAsLong() <= RetryPolicy.MAXIMUM_RETRY_AFTER_MILLIS) {
                    backoff(attempt, retryAfter);
                    continue;
                }
                // The server asked for a longer pause than a caller should wait: report it now.
            }
            return ResponseDecoder.decode(response, attempt);
        }
    }

    private void backoff(int retry, OptionalLong retryAfterMillis) throws InterruptedException {
        long jitter = options.jitter().applyAsLong(RetryPolicy.delayBoundMillis(retry));
        long delay = Math.max(jitter, retryAfterMillis.orElse(0));
        options.sleeper().sleep(Duration.ofMillis(delay));
    }
}
