package ai.cekat.events.transport;

import java.net.URI;
import java.time.Duration;
import java.util.Map;

/**
 * One HTTP attempt.
 *
 * @param uri ingest URI
 * @param headers request headers
 * @param body JSON body
 * @param timeout per-attempt timeout covering connection, headers, and body
 */
public record TransportRequest(URI uri, Map<String, String> headers, byte[] body, Duration timeout) {
    /** Copies headers and body defensively. */
    public TransportRequest {
        headers = Map.copyOf(headers);
        body = body.clone();
    }

    @Override
    public byte[] body() {
        return body.clone();
    }

    @Override
    public String toString() {
        return "TransportRequest[uri=" + uri + ", timeout=" + timeout + "]";
    }

    @Override
    public boolean equals(Object other) {
        return this == other;
    }

    @Override
    public int hashCode() {
        return System.identityHashCode(this);
    }
}
