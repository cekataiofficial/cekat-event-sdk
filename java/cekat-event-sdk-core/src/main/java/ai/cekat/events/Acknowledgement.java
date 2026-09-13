package ai.cekat.events;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Cekat accepted the event for asynchronous processing. This does not confirm durable storage, identity resolution,
 * delivery completion, or analytics availability.
 */
public final class Acknowledgement {
    private final String message;
    private final String eventKey;
    private final List<String> validatedProperties;
    private final byte[] rawBody;

    /**
     * Creates an acknowledgement.
     *
     * @param message server message
     * @param eventKey accepted event key
     * @param validatedProperties property names the server validated
     * @param rawBody response body bytes
     */
    public Acknowledgement(String message, String eventKey, List<String> validatedProperties, byte[] rawBody) {
        this.message = message;
        this.eventKey = eventKey;
        this.validatedProperties = List.copyOf(validatedProperties);
        this.rawBody = rawBody.clone();
    }

    /**
     * Always {@code true}; failures are reported as exceptions.
     *
     * @return {@code true}
     */
    public boolean success() {
        return true;
    }

    /**
     * Returns the server message.
     *
     * @return message
     */
    public String message() {
        return message;
    }

    /**
     * Returns the accepted event key.
     *
     * @return event key
     */
    public String eventKey() {
        return eventKey;
    }

    /**
     * Returns the property names the server validated.
     *
     * @return unmodifiable list
     */
    public List<String> validatedProperties() {
        return validatedProperties;
    }

    /**
     * Returns a copy of the response body bytes.
     *
     * @return body bytes
     */
    public byte[] rawBody() {
        return rawBody.clone();
    }

    /**
     * Returns the response body decoded as UTF-8.
     *
     * @return body text
     */
    public String rawBodyText() {
        return new String(rawBody, StandardCharsets.UTF_8);
    }

    @Override
    public String toString() {
        return "Acknowledgement[eventKey=" + eventKey + ", message=" + message + ", validatedProperties=" + validatedProperties + "]";
    }
}
