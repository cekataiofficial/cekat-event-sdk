package ai.cekat.events;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.cekat.events.error.ApiException;
import ai.cekat.events.error.ResponseDecodeException;
import ai.cekat.events.error.TransportException;
import ai.cekat.events.error.ValidationException;
import ai.cekat.events.internal.Json;
import ai.cekat.events.support.FakeTransport;
import ai.cekat.events.transport.TransportFailureException;
import ai.cekat.events.transport.TransportRequest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class CekatClientTest {
    private static final String TOKEN = "token-that-must-not-leak";

    private final List<Long> sleeps = new ArrayList<>();
    private final List<Long> bounds = new ArrayList<>();

    private CekatClient client(FakeTransport transport) {
        return client(transport, CekatClientOptions.builder());
    }

    private CekatClient client(FakeTransport transport, CekatClientOptions.Builder builder) {
        return new CekatClient(TOKEN, builder.baseUrl("https://ingest.example.test/").transport(transport)
                .sleeper(duration -> sleeps.add(duration.toMillis())).jitter(bound -> {
                    bounds.add(bound);
                    return 0;
                }).build());
    }

    private static Event event() {
        return Event.builder().email("ada@example.test").build();
    }

    private static Map<?, ?> payload(FakeTransport transport, int index) {
        return (Map<?, ?>) Json.parse(transport.body(index));
    }

    @Test
    void postsFixedEndpointWithHeaders() throws Exception {
        FakeTransport transport = new FakeTransport();
        Acknowledgement ack = client(transport).userLogin(event());
        assertEquals("accepted", ack.message());
        TransportRequest request = transport.requests().get(0);
        assertEquals("https://ingest.example.test/api/events/ingest", request.uri().toString());
        assertEquals("Bearer " + TOKEN, request.headers().get("Authorization"));
        assertEquals("application/json", request.headers().get("Content-Type"));
        assertEquals("cekat-event-sdk-java/" + CekatClient.VERSION + " java/" + Runtime.version().feature(), request.headers().get("User-Agent"));
        assertEquals(Duration.ofSeconds(3), request.timeout());
        assertFalse(payload(transport, 0).containsKey("business_id"));
        assertFalse(client(transport).toString().contains(TOKEN));
    }

    @Test
    void mapsOperationsToKeysFlagsAndOrderPaidArguments() throws Exception {
        FakeTransport transport = new FakeTransport();
        CekatClient client = client(transport);
        Event event = Event.builder().email("ada@example.test").property("order", "A-1").build();
        client.userRegistration(event);
        client.userLogin(event);
        client.orderCreated(event);
        client.orderPaid(125.75, "IDR", event);
        client.customEvent("trial_started", event);
        List<List<Object>> summary = new ArrayList<>();
        for (int index = 0; index < 5; index++) {
            Map<?, ?> payload = payload(transport, index);
            summary.add(List.of(payload.get("event_key"), payload.get("is_common"), Json.write(payload.get("properties"))));
        }
        assertEquals(List.of(
                List.of("user_registration", true, "{\"order\":\"A-1\"}"),
                List.of("user_login", true, "{\"order\":\"A-1\"}"),
                List.of("order_created", true, "{\"order\":\"A-1\"}"),
                List.of("order_paid", true, "{\"order\":\"A-1\",\"amount\":125.75,\"currency\":\"IDR\"}"),
                List.of("trial_started", false, "{\"order\":\"A-1\"}")), summary);
    }

    @Test
    void validatesBeforeAnyRequest() {
        FakeTransport transport = new FakeTransport();
        CekatClient client = client(transport);
        assertThrows(ValidationException.class, () -> client.userLogin(Event.builder().contactName("Ada").build()));
        assertThrows(ValidationException.class, () -> client.customEvent(" ", event()));
        assertThrows(ValidationException.class, () -> client.orderPaid(Double.POSITIVE_INFINITY, "IDR", event()));
        assertThrows(ValidationException.class, () -> client.orderPaid(1, " ", event()));
        assertTrue(transport.requests().isEmpty());
    }

    @Test
    void usesScopedVisitorWithExplicitPrecedence() throws Exception {
        FakeTransport transport = new FakeTransport();
        CekatClient client = client(transport);
        try (VisitorContext.Scope ignored = VisitorContext.open(" scoped ")) {
            client.userLogin(event());
            client.userLogin(event().toBuilder().visitorId(" explicit ").build());
            client.userLogin(event().toBuilder().visitorId(" ").build());
        }
        client.userLogin(event());
        List<Object> visitors = new ArrayList<>();
        for (int index = 0; index < 4; index++) {
            visitors.add(payload(transport, index).get("visitor_id"));
        }
        assertEquals(java.util.Arrays.asList("scoped", "explicit", "scoped", null), visitors);
    }

    @ParameterizedTest
    @ValueSource(ints = {429, 500, 502, 503, 504})
    void retriesTransientStatusWithIdenticalBody(int status) throws Exception {
        FakeTransport transport = new FakeTransport().enqueue(FakeTransport.response(status, "transient"), FakeTransport.response(200, FakeTransport.SUCCESS));
        client(transport).orderPaid(1, "IDR", event());
        assertEquals(2, transport.requests().size());
        assertEquals(transport.body(0), transport.body(1));
    }

    @Test
    void doesNotRetryPermanentStatuses() {
        for (int status : List.of(400, 401, 404, 409, 422, 501)) {
            FakeTransport transport = new FakeTransport().enqueue(FakeTransport.response(status, "{\"success\":false,\"error\":\"permanent\"}"));
            ApiException error = assertThrows(ApiException.class, () -> client(transport).userLogin(event()));
            assertEquals(status, error.statusCode());
            assertEquals(1, error.attempts());
            assertEquals(1, transport.requests().size());
        }
        assertTrue(sleeps.isEmpty());
    }

    @Test
    void exhaustsRetriesWithCappedExponentialBounds() {
        FakeTransport transport = new FakeTransport();
        for (int index = 0; index < 7; index++) {
            transport.enqueue(FakeTransport.response(500, "{\"success\":false,\"error\":\"temporary\"}"));
        }
        ApiException error = assertThrows(ApiException.class, () -> client(transport, CekatClientOptions.builder().retryCount(6)).userLogin(event()));
        assertEquals(7, error.attempts());
        assertEquals(List.of(100L, 200L, 400L, 800L, 1000L, 1000L), bounds);
    }

    @Test
    void transportFailuresRetryThenReportUnknownOutcome() {
        FakeTransport transport = new FakeTransport().enqueue(new TransportFailureException("java.net.ConnectException: reset"),
                FakeTransport.response(503, ""), new TransportFailureException("java.net.http.HttpTimeoutException: final"));
        TransportException error = assertThrows(TransportException.class, () -> client(transport).userLogin(event()));
        assertEquals(3, error.attempts());
        assertTrue(error.deliveryOutcomeUnknown());
        assertInstanceOf(TransportFailureException.class, error.getCause());
        assertFalse((error.getMessage() + error.getCause().getMessage()).contains(TOKEN));
    }

    @Test
    void retryAfterRaisesDelayAndStopsBeyondFiveSeconds() throws Exception {
        FakeTransport transport = new FakeTransport().enqueue(
                FakeTransport.response(429, "slow", Map.of("retry-after", List.of("2")), null),
                FakeTransport.response(503, "slow", Map.of("Retry-After", List.of("soon")), null),
                FakeTransport.response(200, FakeTransport.SUCCESS));
        client(transport).userLogin(event());
        assertEquals(List.of(2000L, 0L), sleeps);

        FakeTransport capped = new FakeTransport().enqueue(FakeTransport.response(503, "maintenance", Map.of("Retry-After", List.of("6")), null));
        ApiException error = assertThrows(ApiException.class, () -> client(capped).userLogin(event()));
        assertEquals(503, error.statusCode());
        assertEquals(1, error.attempts());
        assertEquals("Service Unavailable", error.getMessage());
    }

    @Test
    void interruptedSuccessBodyIsNeverRetriedButRetryableStatusIs() throws Exception {
        RuntimeException reset = new RuntimeException("reset");
        FakeTransport accepted = new FakeTransport().enqueue(FakeTransport.response(200, "{\"success\":tr", Map.of(), reset));
        ResponseDecodeException error = assertThrows(ResponseDecodeException.class, () -> client(accepted).userLogin(event()));
        assertEquals(1, error.attempts());
        assertEquals(1, accepted.requests().size());

        FakeTransport retryable = new FakeTransport().enqueue(FakeTransport.response(500, "", Map.of(), reset),
                FakeTransport.response(200, FakeTransport.SUCCESS));
        client(retryable).userLogin(event());
        assertEquals(2, retryable.requests().size());
    }

    @Test
    void interruptionIsNeverRetriedOrWrapped() {
        FakeTransport transport = new FakeTransport();
        Thread.currentThread().interrupt();
        assertThrows(InterruptedException.class, () -> client(transport).userLogin(event()));
        assertTrue(transport.requests().isEmpty());

        FakeTransport interrupting = new FakeTransport().enqueue(new InterruptedException("stop"));
        assertThrows(InterruptedException.class, () -> client(interrupting).userLogin(event()));
        assertEquals(1, interrupting.requests().size());

        FakeTransport backoff = new FakeTransport().enqueue(FakeTransport.response(500, ""));
        CekatClient client = new CekatClient(TOKEN, CekatClientOptions.builder().transport(backoff)
                .sleeper(duration -> {
                    throw new InterruptedException("stop during backoff");
                }).build());
        assertThrows(InterruptedException.class, () -> client.userLogin(event()));
        assertEquals(1, backoff.requests().size());
    }
}
