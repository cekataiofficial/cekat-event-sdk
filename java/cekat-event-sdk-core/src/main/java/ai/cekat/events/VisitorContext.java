package ai.cekat.events;

import java.util.Optional;

/**
 * Thread-scoped visitor ID for the request currently executing on this thread. A nonblank
 * {@value #HEADER_NAME} header wins over a nonblank {@value #COOKIE_NAME} cookie; values are trimmed.
 *
 * <p>Scopes are opened with try-with-resources and restore the previous value when closed. The scope does not
 * propagate into executor tasks, {@code CompletableFuture}s, or other threads: capture the visitor ID and pass it in
 * {@link Event#visitorId()} instead. Visitor IDs are untrusted correlation data; never use them for authentication or
 * authorization.
 */
public final class VisitorContext {
    /** Request header carrying the visitor ID. */
    public static final String HEADER_NAME = "X-Cekat-Visitor-ID";
    /** Cookie set by the Cekat browser tracker. */
    public static final String COOKIE_NAME = "_cekat_visitor_id";

    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private VisitorContext() {
    }

    /**
     * Returns the visitor ID of the current scope.
     *
     * @return the visitor ID, if a scope with a visitor is open
     */
    public static Optional<String> currentVisitorId() {
        return Optional.ofNullable(CURRENT.get());
    }

    /**
     * Opens a scope with an explicit visitor ID. A blank or {@code null} value opens a scope with no visitor.
     *
     * @param visitorId visitor ID
     * @return the scope to close
     */
    public static Scope open(String visitorId) {
        return new Scope(normalize(visitorId));
    }

    /**
     * Opens a scope with the visitor ID resolved from a request.
     *
     * @param request request view
     * @return the scope to close
     */
    public static Scope open(VisitorRequest request) {
        return new Scope(resolve(request).orElse(null));
    }

    /**
     * Resolves the visitor ID from a request without opening a scope.
     *
     * @param request request view
     * @return the trimmed visitor ID, if the header or cookie is nonblank
     */
    public static Optional<String> resolve(VisitorRequest request) {
        String header = normalize(request.firstHeader(HEADER_NAME).orElse(null));
        if (header != null) {
            return Optional.of(header);
        }
        return Optional.ofNullable(normalize(request.cookie(COOKIE_NAME).orElse(null)));
    }

    /**
     * Returns the first nonblank {@value #COOKIE_NAME} value in a raw {@code Cookie} header.
     *
     * @param cookieHeader raw header value; may be {@code null}
     * @return the trimmed, undecoded value, if present
     */
    public static Optional<String> fromCookieHeader(String cookieHeader) {
        if (cookieHeader == null) {
            return Optional.empty();
        }
        for (String pair : cookieHeader.split(";")) {
            int separator = pair.indexOf('=');
            if (separator < 0 || !pair.substring(0, separator).trim().equals(COOKIE_NAME)) {
                continue;
            }
            String value = normalize(pair.substring(separator + 1));
            if (value != null) {
                return Optional.of(value);
            }
        }
        return Optional.empty();
    }

    static String normalize(String visitorId) {
        if (visitorId == null) {
            return null;
        }
        String trimmed = visitorId.strip();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** An open visitor scope. Closing it restores the previous visitor exactly once. */
    public static final class Scope implements AutoCloseable {
        private final String previous;
        private final Thread owner;
        private boolean closed;

        private Scope(String visitorId) {
            this.previous = CURRENT.get();
            this.owner = Thread.currentThread();
            set(visitorId);
        }

        @Override
        public void close() {
            if (closed || Thread.currentThread() != owner) {
                return;
            }
            closed = true;
            set(previous);
        }

        private static void set(String value) {
            if (value == null) {
                CURRENT.remove();
            } else {
                CURRENT.set(value);
            }
        }
    }
}
