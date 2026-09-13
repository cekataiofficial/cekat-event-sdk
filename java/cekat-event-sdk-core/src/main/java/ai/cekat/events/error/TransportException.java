package ai.cekat.events.error;

/**
 * No response was received after all attempts. Cekat may still have received the event, so the delivery outcome is
 * unknown and resending it can create a duplicate.
 */
public final class TransportException extends CekatException {
    private static final long serialVersionUID = 1L;

    private final int attempts;

    /**
     * Creates a transport exception.
     *
     * @param message safe message
     * @param attempts attempts made
     * @param cause last transport failure
     */
    public TransportException(String message, int attempts, Throwable cause) {
        super(message, cause);
        this.attempts = attempts;
    }

    @Override
    public int attempts() {
        return attempts;
    }

    @Override
    public boolean deliveryOutcomeUnknown() {
        return true;
    }
}
