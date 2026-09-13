package ai.cekat.events.transport;

/** Sends one HTTP attempt. Implementations must not retry or follow redirects. */
@FunctionalInterface
public interface HttpTransport {
    /**
     * Executes one attempt.
     *
     * @param request the attempt
     * @return the response once its status arrived, even if the body read then failed
     * @throws TransportFailureException when no response status was received
     * @throws InterruptedException when the calling thread is interrupted
     */
    TransportResponse execute(TransportRequest request) throws TransportFailureException, InterruptedException;
}
