package ai.cekat.events.error;

/** Base class for every exception thrown by the Cekat SDK. */
public abstract class CekatException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    /**
     * Creates an exception.
     *
     * @param message safe message that never contains the access token
     * @param cause underlying cause, or {@code null}
     */
    protected CekatException(String message, Throwable cause) {
        super(message, cause);
    }

    /**
     * Number of HTTP attempts made; zero when nothing was sent.
     *
     * @return attempts
     */
    public abstract int attempts();

    /**
     * Whether Cekat may have received the event even though no response was seen.
     *
     * @return {@code true} only for transport failures
     */
    public abstract boolean deliveryOutcomeUnknown();
}
