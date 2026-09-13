package ai.cekat.events;

import java.util.Optional;

/** Framework-neutral view of an inbound request, used to resolve the browser visitor ID. */
public interface VisitorRequest {
    /**
     * Returns the first value of a request header.
     *
     * @param name header name, matched case-insensitively
     * @return the header value, if present
     */
    Optional<String> firstHeader(String name);

    /**
     * Returns a raw (not decoded) cookie value.
     *
     * @param name cookie name
     * @return the cookie value, if present
     */
    Optional<String> cookie(String name);
}
