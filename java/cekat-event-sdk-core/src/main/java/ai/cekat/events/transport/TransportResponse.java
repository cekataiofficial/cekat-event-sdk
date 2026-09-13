package ai.cekat.events.transport;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * A received response. The body holds at most 65,536 bytes.
 *
 * @param statusCode HTTP status
 * @param headers response headers
 * @param body retained body bytes
 * @param bodyTruncated whether the server sent more than 65,536 bytes
 * @param observedBodyBytes bytes examined (retained bytes plus at most one sentinel byte)
 * @param bodyReadFailure failure that occurred after the status arrived, or {@code null}
 */
public record TransportResponse(
        int statusCode,
        Map<String, List<String>> headers,
        byte[] body,
        boolean bodyTruncated,
        int observedBodyBytes,
        Throwable bodyReadFailure) {

    /** Maximum retained response bytes. */
    public static final int MAX_BODY_BYTES = 65_536;

    /** Copies headers and body defensively. */
    public TransportResponse {
        headers = Map.copyOf(headers);
        body = body.clone();
    }

    @Override
    public byte[] body() {
        return body.clone();
    }

    /**
     * Returns the first value of a header, matched case-insensitively.
     *
     * @param name header name
     * @return the value, if present
     */
    public Optional<String> header(String name) {
        String wanted = name.toLowerCase(Locale.ROOT);
        return headers.entrySet().stream()
                .filter(entry -> entry.getKey().toLowerCase(Locale.ROOT).equals(wanted) && !entry.getValue().isEmpty())
                .map(entry -> entry.getValue().get(0))
                .findFirst();
    }

    @Override
    public String toString() {
        return "TransportResponse[statusCode=" + statusCode + ", bodyBytes=" + body.length + ", truncated=" + bodyTruncated + "]";
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
