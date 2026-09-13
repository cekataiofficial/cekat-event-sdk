package ai.cekat.events.internal;

import ai.cekat.events.Event;
import ai.cekat.events.error.ValidationException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

/** Validates events and encodes the JSON request body. Not public API. */
public final class PayloadEncoder {
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final BigDecimal MAX_SAFE = BigDecimal.valueOf(MAX_SAFE_INTEGER);
    private static final int MAX_DEPTH = 256;
    private static final DateTimeFormatter OCCURRED_AT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(ZoneOffset.UTC);
    private static final Instant MIN_OCCURRED_AT = Instant.parse("0001-01-01T00:00:00Z");
    private static final Instant MAX_OCCURRED_AT = Instant.parse("9999-12-31T23:59:59.999Z");

    private final Supplier<Instant> clock;
    private final Supplier<String> idGenerator;

    /** Creates an encoder using the system clock and random UUIDs. */
    public PayloadEncoder() {
        this(Instant::now, () -> UUID.randomUUID().toString());
    }

    /**
     * Creates an encoder with test seams.
     *
     * @param clock call-time source
     * @param idGenerator event ID source
     */
    public PayloadEncoder(Supplier<Instant> clock, Supplier<String> idGenerator) {
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    /**
     * Returns a copy of {@code event} whose properties include the order_paid arguments.
     *
     * @param amount finite amount
     * @param currency nonblank currency
     * @param event event
     * @return the merged event
     */
    public static Event withOrderPaidProperties(Number amount, String currency, Event event) {
        if (amount == null || (amount instanceof Double value && !Double.isFinite(value))
                || (amount instanceof Float value && !Float.isFinite(value))) {
            throw new ValidationException("amount must be a finite number");
        }
        if (currency == null || currency.isBlank()) {
            throw new ValidationException("currency must not be blank");
        }
        if (event == null) {
            throw new ValidationException("event must not be null");
        }
        for (String reserved : List.of("amount", "currency")) {
            if (event.properties().containsKey(reserved)) {
                throw new ValidationException("properties must not contain \"" + reserved + "\"; pass it as the orderPaid argument");
            }
        }
        Map<String, Object> properties = new LinkedHashMap<>(event.properties());
        properties.put("amount", amount);
        properties.put("currency", currency);
        return event.toBuilder().properties(properties).build();
    }

    /**
     * Validates the event and encodes the request body.
     *
     * @param eventKey event key
     * @param isCommon whether this is a common event
     * @param event event
     * @param ambientVisitorId visitor from the current scope, or {@code null}
     * @return UTF-8 JSON bytes
     */
    public byte[] encode(String eventKey, boolean isCommon, Event event, String ambientVisitorId) {
        if (eventKey == null || eventKey.isBlank()) {
            throw new ValidationException("event key must not be blank");
        }
        if (event == null) {
            throw new ValidationException("event must not be null");
        }
        if (isBlank(event.email()) && isBlank(event.phoneNumber())) {
            throw new ValidationException("event must include a nonblank email or phone number");
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("event_key", text(eventKey, "event_key"));
        String explicitEventId = trimToNull(event.eventId());
        payload.put("event_id", explicitEventId != null ? text(explicitEventId, "event_id") : idGenerator.get());
        payload.put("occurred_at", occurredAt(event.occurredAt()));
        payload.put("is_common", isCommon);
        putIfPresent(payload, "email", event.email());
        putIfPresent(payload, "phone_number", event.phoneNumber());
        putIfPresent(payload, "contact_name", event.contactName());
        String visitorId = trimToNull(event.visitorId());
        if (visitorId == null) {
            visitorId = trimToNull(ambientVisitorId);
        }
        putIfPresent(payload, "visitor_id", visitorId);
        if (!event.properties().isEmpty()) {
            payload.put("properties", normalize(event.properties(), "properties", new IdentityHashMap<>(), 0));
        }
        return Json.write(payload).getBytes(StandardCharsets.UTF_8);
    }

    private String occurredAt(Instant value) {
        Instant time = value == null ? clock.get() : value;
        if (time.isBefore(MIN_OCCURRED_AT) || time.isAfter(MAX_OCCURRED_AT)) {
            throw new ValidationException("occurredAt must be between years 0001 and 9999");
        }
        return OCCURRED_AT.format(time);
    }

    private static void putIfPresent(Map<String, Object> payload, String name, String value) {
        if (value != null) {
            payload.put(name, text(value, name));
        }
    }

    private static Object normalize(Object value, String path, IdentityHashMap<Object, Boolean> ancestors, int depth) {
        if (depth > MAX_DEPTH) {
            throw new ValidationException(path + " is nested too deeply");
        }
        if (value == null || value instanceof Boolean) {
            return value;
        }
        if (value instanceof String text) {
            return text(text, path);
        }
        if (value instanceof Byte || value instanceof Short || value instanceof Integer) {
            return value;
        }
        if (value instanceof Long number) {
            if (number < -MAX_SAFE_INTEGER || number > MAX_SAFE_INTEGER) {
                throw invalid(path);
            }
            return number;
        }
        if (value instanceof BigInteger number) {
            if (number.abs().compareTo(MAX_SAFE.toBigInteger()) > 0) {
                throw invalid(path);
            }
            return number;
        }
        if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number) || (number == Math.rint(number) && Math.abs(number) > MAX_SAFE_INTEGER)) {
                throw invalid(path);
            }
            return value instanceof Float ? new BigDecimal(value.toString()) : value;
        }
        if (value instanceof BigDecimal number) {
            BigDecimal stripped = number.stripTrailingZeros();
            if (stripped.scale() <= 0 && stripped.abs().compareTo(MAX_SAFE) > 0) {
                throw invalid(path);
            }
            return number;
        }
        if (value instanceof Map<?, ?> map) {
            enter(value, path, ancestors);
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new ValidationException(path + " has a non-String key; property keys must be Strings");
                }
                String childPath = key.isEmpty() ? path + "[\"\"]" : path + "." + key;
                copy.put(text(key, path), normalize(entry.getValue(), childPath, ancestors, depth + 1));
            }
            ancestors.remove(value);
            return copy;
        }
        if (value instanceof List<?> list) {
            enter(value, path, ancestors);
            List<Object> copy = new java.util.ArrayList<>(list.size());
            for (int index = 0; index < list.size(); index++) {
                copy.add(normalize(list.get(index), path + "[" + index + "]", ancestors, depth + 1));
            }
            ancestors.remove(value);
            return copy;
        }
        throw invalid(path);
    }

    private static void enter(Object container, String path, IdentityHashMap<Object, Boolean> ancestors) {
        if (ancestors.put(container, Boolean.TRUE) != null) {
            throw new ValidationException(path + " contains a cycle");
        }
    }

    private static String text(String value, String path) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (Character.isHighSurrogate(character)) {
                if (index + 1 < value.length() && Character.isLowSurrogate(value.charAt(index + 1))) {
                    index++;
                    continue;
                }
                throw new ValidationException(path + " must be valid Unicode");
            }
            if (Character.isLowSurrogate(character)) {
                throw new ValidationException(path + " must be valid Unicode");
            }
        }
        return value;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.strip();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static ValidationException invalid(String path) {
        return new ValidationException(path + " is not a JSON-compatible value");
    }
}
