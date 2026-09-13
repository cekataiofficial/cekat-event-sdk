package ai.cekat.events.transport;

import java.io.IOException;

/** No response status was received for an attempt. Messages never contain request headers. */
public final class TransportFailureException extends IOException {
    private static final long serialVersionUID = 1L;

    /**
     * Creates a failure from a transport error, keeping only its type and message.
     *
     * @param cause underlying error
     * @return the failure
     */
    public static TransportFailureException from(Throwable cause) {
        return new TransportFailureException(cause.getClass().getName() + ": " + cause.getMessage());
    }

    /**
     * Creates a failure.
     *
     * @param message safe message
     */
    public TransportFailureException(String message) {
        super(message);
    }
}
