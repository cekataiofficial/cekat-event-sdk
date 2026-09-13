package ai.cekat.events.servlet;

import ai.cekat.events.VisitorContext;
import ai.cekat.events.VisitorRequest;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Optional;

/** Resolves and stores the visitor ID of a servlet request. */
public final class CekatServletRequest {
    /** Request attribute holding the trimmed visitor ID for the lifetime of the request, including async dispatches. */
    public static final String VISITOR_ID_ATTRIBUTE = "ai.cekat.events.servlet.visitorId.v1";

    static final String RESOLVED_ATTRIBUTE = "ai.cekat.events.servlet.resolved.v1";

    private CekatServletRequest() {
    }

    /**
     * Returns the request's visitor ID: the stored attribute when present, otherwise the header, then the cookie.
     *
     * @param request servlet request
     * @return trimmed visitor ID, if any
     */
    public static Optional<String> visitorId(HttpServletRequest request) {
        if (request.getAttribute(RESOLVED_ATTRIBUTE) != null) {
            return Optional.ofNullable((String) request.getAttribute(VISITOR_ID_ATTRIBUTE));
        }
        return VisitorContext.resolve(asVisitorRequest(request));
    }

    /**
     * Opens a {@link VisitorContext} scope for the request's visitor on the current thread.
     *
     * @param request servlet request
     * @return the scope to close
     */
    public static VisitorContext.Scope openScope(HttpServletRequest request) {
        return VisitorContext.open(visitorId(request).orElse(null));
    }

    static void store(HttpServletRequest request) {
        if (request.getAttribute(RESOLVED_ATTRIBUTE) != null) {
            return;
        }
        Optional<String> visitorId = VisitorContext.resolve(asVisitorRequest(request));
        request.setAttribute(RESOLVED_ATTRIBUTE, Boolean.TRUE);
        visitorId.ifPresentOrElse(value -> request.setAttribute(VISITOR_ID_ATTRIBUTE, value),
                () -> request.removeAttribute(VISITOR_ID_ATTRIBUTE));
    }

    static void clear(HttpServletRequest request) {
        request.removeAttribute(VISITOR_ID_ATTRIBUTE);
        request.removeAttribute(RESOLVED_ATTRIBUTE);
    }

    /**
     * Adapts a servlet request. The raw {@code Cookie} header is preferred so values are never decoded.
     *
     * @param request servlet request
     * @return visitor request view
     */
    public static VisitorRequest asVisitorRequest(HttpServletRequest request) {
        return new VisitorRequest() {
            @Override
            public Optional<String> firstHeader(String name) {
                return Optional.ofNullable(request.getHeader(name));
            }

            @Override
            public Optional<String> cookie(String name) {
                java.util.Enumeration<String> headers = request.getHeaders("Cookie");
                while (headers != null && headers.hasMoreElements()) {
                    Optional<String> value = VisitorContext.fromCookieHeader(headers.nextElement());
                    if (value.isPresent()) {
                        return value;
                    }
                }
                Cookie[] cookies = request.getCookies();
                if (cookies != null) {
                    for (Cookie cookie : cookies) {
                        if (name.equals(cookie.getName()) && cookie.getValue() != null && !cookie.getValue().isBlank()) {
                            return Optional.of(cookie.getValue());
                        }
                    }
                }
                return Optional.empty();
            }
        };
    }
}
