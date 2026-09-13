package ai.cekat.events.error;

import java.util.Optional;

/**
 * Cekat returned a non-200 response; the delivery outcome is known. {@link AuthenticationException} (401) and
 * {@link EventDefinitionNotFoundException} (404) extend this class.
 */
public class ApiException extends CekatException {
    private static final long serialVersionUID = 1L;

    private final int statusCode;
    private final String serverCode;
    private final byte[] rawBody;
    private final int attempts;

    /**
     * Creates an API exception.
     *
     * @param message server error text or HTTP status text
     * @param statusCode HTTP status
     * @param serverCode optional server error code
     * @param rawBody first 65,536 response bytes
     * @param attempts attempts made
     */
    public ApiException(String message, int statusCode, String serverCode, byte[] rawBody, int attempts) {
        super(message, null);
        this.statusCode = statusCode;
        this.serverCode = serverCode;
        this.rawBody = rawBody.clone();
        this.attempts = attempts;
    }

    /**
     * Returns the HTTP status.
     *
     * @return status code
     */
    public int statusCode() {
        return statusCode;
    }

    /**
     * Returns the server error code, when the body was a structured error.
     *
     * @return server code
     */
    public Optional<String> serverCode() {
        return Optional.ofNullable(serverCode);
    }

    /**
     * Returns a copy of the first 65,536 response bytes.
     *
     * @return body bytes
     */
    public byte[] rawBody() {
        return rawBody.clone();
    }

    @Override
    public int attempts() {
        return attempts;
    }

    @Override
    public boolean deliveryOutcomeUnknown() {
        return false;
    }
}
