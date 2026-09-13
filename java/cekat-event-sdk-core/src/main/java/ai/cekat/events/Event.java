package ai.cekat.events;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * An identity-bearing event. At least one of {@code email} or {@code phoneNumber} must be nonblank.
 *
 * <p>{@code properties} values may be {@code null}, {@link Boolean}, {@link String}, finite numbers ({@code Byte},
 * {@code Short}, {@code Integer}, {@code Long}, {@code Float}, {@code Double}, {@code BigInteger}, {@code BigDecimal}),
 * {@link java.util.List}s, and {@link Map}s with {@link String} keys. Integers must be within ±(2^53−1).
 *
 * <p>{@code eventId} lets Cekat deduplicate deliveries; when blank the SDK generates a random UUID and reuses it for
 * every retry. {@code occurredAt} defaults to the time of the call.
 *
 * @param email contact email; transmitted unchanged
 * @param phoneNumber contact phone number; transmitted unchanged
 * @param contactName optional display name
 * @param visitorId explicit visitor ID; a nonblank value takes precedence over the request scope
 * @param properties event properties; never {@code null}
 * @param eventId optional caller event ID used for deduplication
 * @param occurredAt optional time the event happened
 */
public record Event(
        String email,
        String phoneNumber,
        String contactName,
        String visitorId,
        Map<String, Object> properties,
        String eventId,
        Instant occurredAt) {

    /** Copies {@code properties} (shallowly) into an unmodifiable map; {@code null} becomes empty. */
    public Event {
        properties = properties == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(properties));
    }

    /**
     * Starts building an event.
     *
     * @return a new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Returns a builder initialized with this event's values.
     *
     * @return a new builder
     */
    public Builder toBuilder() {
        return new Builder().email(email).phoneNumber(phoneNumber).contactName(contactName).visitorId(visitorId)
                .properties(properties).eventId(eventId).occurredAt(occurredAt);
    }

    /** Builds {@link Event} values. */
    public static final class Builder {
        private String email;
        private String phoneNumber;
        private String contactName;
        private String visitorId;
        private Map<String, Object> properties = Map.of();
        private String eventId;
        private Instant occurredAt;

        private Builder() {
        }

        /**
         * Sets the contact email.
         *
         * @param value email, transmitted unchanged
         * @return this builder
         */
        public Builder email(String value) {
            this.email = value;
            return this;
        }

        /**
         * Sets the contact phone number.
         *
         * @param value phone number, transmitted unchanged
         * @return this builder
         */
        public Builder phoneNumber(String value) {
            this.phoneNumber = value;
            return this;
        }

        /**
         * Sets the contact display name.
         *
         * @param value display name
         * @return this builder
         */
        public Builder contactName(String value) {
            this.contactName = value;
            return this;
        }

        /**
         * Sets an explicit visitor ID that takes precedence over the request scope.
         *
         * @param value visitor ID
         * @return this builder
         */
        public Builder visitorId(String value) {
            this.visitorId = value;
            return this;
        }

        /**
         * Replaces all properties.
         *
         * @param value properties; {@code null} clears them
         * @return this builder
         */
        public Builder properties(Map<String, ?> value) {
            this.properties = value == null ? Map.of() : new LinkedHashMap<>(value);
            return this;
        }

        /**
         * Adds or replaces one property.
         *
         * @param name property name
         * @param value property value
         * @return this builder
         */
        public Builder property(String name, Object value) {
            Map<String, Object> copy = new LinkedHashMap<>(properties);
            copy.put(name, value);
            this.properties = copy;
            return this;
        }

        /**
         * Sets the caller event ID used for deduplication.
         *
         * @param value event ID
         * @return this builder
         */
        public Builder eventId(String value) {
            this.eventId = value;
            return this;
        }

        /**
         * Sets when the event happened.
         *
         * @param value event time
         * @return this builder
         */
        public Builder occurredAt(Instant value) {
            this.occurredAt = value;
            return this;
        }

        /**
         * Builds the event.
         *
         * @return the event
         */
        public Event build() {
            return new Event(email, phoneNumber, contactName, visitorId, properties, eventId, occurredAt);
        }
    }
}
