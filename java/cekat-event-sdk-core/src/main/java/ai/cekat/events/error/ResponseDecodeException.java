package ai.cekat.events.error;

/**
 * Cekat returned HTTP 200 but the body was not a valid success envelope, exceeded 65,536 bytes, or could not be read.
 * The event was received; it is never retried.
 */
public final class ResponseDecodeException extends CekatException {
    private static final long serialVersionUID = 1L;

    private final byte[] rawBody;
    private final int attempts;

    /**
     * Creates a response decode exception.
     *
     * @param message safe message
     * @param rawBody retained response bytes
     * @param attempts attempts made
     * @param cause decode or read failure, or {@code null}
     */
    public ResponseDecodeException(String message, byte[] rawBody, int attempts, Throwable cause) {
        super(message, cause);
        this.rawBody = rawBody.clone();
        this.attempts = attempts;
    }

    /**
     * Always 200.
     *
     * @return 200
     */
    public int statusCode() {
        return 200;
    }

    /**
     * Returns a copy of the retained response bytes.
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
