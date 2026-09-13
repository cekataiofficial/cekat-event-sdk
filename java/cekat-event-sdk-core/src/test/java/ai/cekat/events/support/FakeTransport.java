package ai.cekat.events.support;

import ai.cekat.events.transport.HttpTransport;
import ai.cekat.events.transport.TransportFailureException;
import ai.cekat.events.transport.TransportRequest;
import ai.cekat.events.transport.TransportResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;

public final class FakeTransport implements HttpTransport {
    public static final String SUCCESS = "{\"success\":true,\"data\":{\"success\":true,\"message\":\"accepted\","
            + "\"event_key\":\"order_paid\",\"validated_properties\":[\"order_id\"]}}";

    private final Deque<Object> outcomes = new ArrayDeque<>();
    private final List<TransportRequest> requests = new ArrayList<>();

    public FakeTransport enqueue(Object... values) {
        outcomes.addAll(List.of(values));
        return this;
    }

    public static TransportResponse response(int status, String body) {
        return response(status, body, Map.of(), null);
    }

    public static TransportResponse response(int status, String body, Map<String, List<String>> headers, Throwable failure) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        return new TransportResponse(status, headers, bytes, false, bytes.length, failure);
    }

    @Override
    public synchronized TransportResponse execute(TransportRequest request) throws TransportFailureException, InterruptedException {
        requests.add(request);
        Object outcome = outcomes.isEmpty() ? response(200, SUCCESS) : outcomes.removeFirst();
        if (outcome instanceof TransportFailureException failure) {
            throw failure;
        }
        if (outcome instanceof InterruptedException interrupted) {
            throw interrupted;
        }
        return (TransportResponse) outcome;
    }

    public synchronized List<TransportRequest> requests() {
        return List.copyOf(requests);
    }

    public synchronized String body(int index) {
        return new String(requests.get(index).body(), StandardCharsets.UTF_8);
    }
}
