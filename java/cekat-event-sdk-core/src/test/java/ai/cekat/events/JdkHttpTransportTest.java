package ai.cekat.events;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.cekat.events.transport.JdkHttpTransport;
import ai.cekat.events.transport.TransportFailureException;
import ai.cekat.events.transport.TransportRequest;
import ai.cekat.events.transport.TransportResponse;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class JdkHttpTransportTest {
    /** Serves one scripted raw HTTP/1.1 response and records the request. */
    private static final class RawServer implements AutoCloseable {
        private final ServerSocket socket;
        private final Thread thread;
        private final AtomicReference<String> request = new AtomicReference<>();

        RawServer(byte[] response, long delayMillis) throws IOException {
            socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
            thread = new Thread(() -> {
                try (Socket client = socket.accept()) {
                    request.set(readRequest(client.getInputStream()));
                    Thread.sleep(delayMillis);
                    OutputStream out = client.getOutputStream();
                    out.write(response);
                    out.flush();
                } catch (IOException | InterruptedException ignored) {
                    // The client may disconnect first in timeout tests.
                }
            });
            thread.start();
        }

        URI uri() {
            return URI.create("http://127.0.0.1:" + socket.getLocalPort() + "/api/events/ingest");
        }

        private static String readRequest(InputStream in) throws IOException {
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            while (!head.toString(StandardCharsets.ISO_8859_1).endsWith("\r\n\r\n")) {
                int next = in.read();
                if (next < 0) {
                    break;
                }
                head.write(next);
            }
            String text = head.toString(StandardCharsets.ISO_8859_1);
            int length = text.lines().filter(line -> line.toLowerCase(Locale.ROOT).startsWith("content-length:"))
                    .mapToInt(line -> Integer.parseInt(line.substring(15).trim())).findFirst().orElse(0);
            return text + new String(in.readNBytes(length), StandardCharsets.UTF_8);
        }

        @Override
        public void close() throws Exception {
            socket.close();
            thread.join(5_000);
        }
    }

    private static TransportResponse send(RawServer server, Duration timeout) throws Exception {
        return new JdkHttpTransport().execute(new TransportRequest(server.uri(),
                Map.of("Content-Type", "application/json", "User-Agent", "cekat-test"), "{\"a\":1}".getBytes(StandardCharsets.UTF_8), timeout));
    }

    private static byte[] raw(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void postsBodyAndReturnsStatusHeadersAndBody() throws Exception {
        try (RawServer server = new RawServer(raw("HTTP/1.1 418 Custom\r\nRetry-After: 1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"), 0)) {
            TransportResponse response = send(server, Duration.ofSeconds(2));
            assertEquals(418, response.statusCode());
            assertEquals("1", response.header("RETRY-AFTER").orElseThrow());
            assertEquals("hello", new String(response.body(), StandardCharsets.UTF_8));
            assertFalse(response.bodyTruncated());
            assertNull(response.bodyReadFailure());
            assertTrue(server.request.get().startsWith("POST /api/events/ingest HTTP/1.1"), server.request.get());
            assertTrue(server.request.get().endsWith("{\"a\":1}"));
            assertTrue(server.request.get().toLowerCase(Locale.ROOT).contains("user-agent: cekat-test"));
        }
    }

    @Test
    void doesNotFollowRedirects() throws Exception {
        try (RawServer server = new RawServer(raw("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), 0)) {
            assertEquals(302, send(server, Duration.ofSeconds(2)).statusCode());
        }
    }

    @Test
    void retainsBoundedPrefixOfOversizedBody() throws Exception {
        byte[] body = raw("€".repeat(21_846) + "END");
        byte[] head = raw("HTTP/1.1 200 OK\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n");
        byte[] response = Arrays.copyOf(head, head.length + body.length);
        System.arraycopy(body, 0, response, head.length, body.length);
        try (RawServer server = new RawServer(response, 0)) {
            TransportResponse result = send(server, Duration.ofSeconds(2));
            assertTrue(result.bodyTruncated());
            assertEquals(65_537, result.observedBodyBytes());
            assertArrayEquals(Arrays.copyOf(body, 65_536), result.body());
            assertNull(result.bodyReadFailure());
        }
    }

    @Test
    void reportsBodyReadFailureAfterHeaders() throws Exception {
        try (RawServer server = new RawServer(raw("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{\"success\":tr"), 0)) {
            TransportResponse response = send(server, Duration.ofSeconds(2));
            assertEquals(200, response.statusCode());
            assertInstanceOf(TransportFailureException.class, response.bodyReadFailure());
        }
    }

    @Test
    void headerTimeoutAndRefusedConnectionAreTransportFailures() throws Exception {
        try (RawServer server = new RawServer(raw("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"), 1_000)) {
            assertThrows(TransportFailureException.class, () -> send(server, Duration.ofMillis(200)));
        }
        assertThrows(TransportFailureException.class, () -> new JdkHttpTransport().execute(new TransportRequest(
                URI.create("http://127.0.0.1:1/api/events/ingest"), Map.of(), new byte[0], Duration.ofMillis(500))));
    }

    @Test
    void interruptionIsPropagatedUnchanged() throws Exception {
        try (RawServer server = new RawServer(raw("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"), 2_000)) {
            Thread caller = Thread.currentThread();
            Thread interrupter = new Thread(() -> {
                try {
                    Thread.sleep(200);
                } catch (InterruptedException ignored) {
                    return;
                }
                caller.interrupt();
            });
            interrupter.start();
            assertThrows(InterruptedException.class, () -> send(server, Duration.ofSeconds(5)));
            interrupter.join();
        }
    }
}
