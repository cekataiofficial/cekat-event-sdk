package ai.cekat.events.error;

/** Invalid configuration or event input, detected before any request is sent. */
public final class ValidationException extends CekatException {
    private static final long serialVersionUID = 1L;

    /**
     * Creates a validation exception.
     *
     * @param message description that never echoes rejected values
     */
    public ValidationException(String message) {
        super(message, null);
    }

    @Override
    public int attempts() {
        return 0;
    }

    @Override
    public boolean deliveryOutcomeUnknown() {
        return false;
    }
}
