package ai.cekat.events.error;

/** The tenant has no definition for the submitted event key (HTTP 404). */
public final class EventDefinitionNotFoundException extends ApiException {
    private static final long serialVersionUID = 1L;

    /**
     * Creates an event-definition-not-found exception.
     *
     * @param message server error text or HTTP status text
     * @param serverCode optional server error code
     * @param rawBody first 65,536 response bytes
     * @param attempts attempts made
     */
    public EventDefinitionNotFoundException(String message, String serverCode, byte[] rawBody, int attempts) {
        super(message, 404, serverCode, rawBody, attempts);
    }
}
