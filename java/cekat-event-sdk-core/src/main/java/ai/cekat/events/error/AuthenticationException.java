package ai.cekat.events.error;

/** Cekat rejected the access token (HTTP 401). */
public final class AuthenticationException extends ApiException {
    private static final long serialVersionUID = 1L;

    /**
     * Creates an authentication exception.
     *
     * @param message server error text or HTTP status text
     * @param serverCode optional server error code
     * @param rawBody first 65,536 response bytes
     * @param attempts attempts made
     */
    public AuthenticationException(String message, String serverCode, byte[] rawBody, int attempts) {
        super(message, 401, serverCode, rawBody, attempts);
    }
}
