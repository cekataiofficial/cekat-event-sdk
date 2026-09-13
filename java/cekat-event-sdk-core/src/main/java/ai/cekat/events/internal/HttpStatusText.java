package ai.cekat.events.internal;

import java.util.Map;

/** Standard reason phrases; Java's HTTP client does not expose the server's. Not public API. */
public final class HttpStatusText {
    private static final Map<Integer, String> TEXT = Map.ofEntries(
            Map.entry(400, "Bad Request"), Map.entry(401, "Unauthorized"), Map.entry(403, "Forbidden"),
            Map.entry(404, "Not Found"), Map.entry(405, "Method Not Allowed"), Map.entry(408, "Request Timeout"),
            Map.entry(409, "Conflict"), Map.entry(413, "Content Too Large"), Map.entry(415, "Unsupported Media Type"),
            Map.entry(418, "I'm a teapot"), Map.entry(422, "Unprocessable Content"), Map.entry(429, "Too Many Requests"),
            Map.entry(500, "Internal Server Error"), Map.entry(501, "Not Implemented"), Map.entry(502, "Bad Gateway"),
            Map.entry(503, "Service Unavailable"), Map.entry(504, "Gateway Timeout"));

    private HttpStatusText() {
    }

    /**
     * Returns the reason phrase for a status.
     *
     * @param status HTTP status
     * @return the phrase, or {@code HTTP <status>} when unmapped
     */
    public static String forStatus(int status) {
        return TEXT.getOrDefault(status, "HTTP " + status);
    }
}
