package ai.cekat.events.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.cekat.events.Event;
import ai.cekat.events.error.ValidationException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class PayloadEncoderTest {
    private static final String UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private final PayloadEncoder encoder = new PayloadEncoder(
            () -> Instant.parse("2026-09-13T01:15:30.250999Z"), () -> "generated-event-id");

    private String encode(String key, boolean common, Event event, String ambient) {
        return new String(encoder.encode(key, common, event, ambient), StandardCharsets.UTF_8);
    }

    private static Event.Builder email() {
        return Event.builder().email("ada@example.test");
    }

    @Test
    void encodesExactPayloadPreservingIdentityWhitespaceAndTrimmingVisitor() {
        Event event = Event.builder().email(" ada@example.test ").phoneNumber(" +6281 ").contactName(" Ada ")
                .visitorId(" explicit\t").property("nested", Arrays.asList("value", 12.5, null)).build();
        assertEquals("{\"event_key\":\" custom_event \",\"event_id\":\"generated-event-id\",\"occurred_at\":\"2026-09-13T01:15:30.250Z\","
                + "\"is_common\":false,\"email\":\" ada@example.test \",\"phone_number\":\" +6281 \",\"contact_name\":\" Ada \","
                + "\"visitor_id\":\"explicit\",\"properties\":{\"nested\":[\"value\",12.5,null]}}",
                encode(" custom_event ", false, event, " ambient "));
    }

    @Test
    void blankExplicitVisitorFallsBackAndAbsentOptionalsAreOmitted() {
        assertTrue(encode("user_login", true, email().visitorId(" ").build(), " ambient ").contains("\"visitor_id\":\"ambient\""));
        assertEquals("{\"event_key\":\"user_login\",\"event_id\":\"generated-event-id\",\"occurred_at\":\"2026-09-13T01:15:30.250Z\","
                + "\"is_common\":true,\"email\":\"ada@example.test\"}", encode("user_login", true, email().build(), "\t"));
    }

    @Test
    void rejectsBlankKeyMissingIdentityAndNullEvent() {
        assertMessage("event key", () -> encode(" \t", true, email().build(), null));
        assertMessage("event key", () -> encode(null, true, email().build(), null));
        assertMessage("email or phone number", () -> encode("user_login", true, Event.builder().email(" ").phoneNumber("\n").build(), null));
        assertMessage("must not be null", () -> encode("user_login", true, null, null));
        assertTrue(encode("user_login", true, Event.builder().phoneNumber("+62").build(), null).contains("\"phone_number\":\"+62\""));
    }

    @Test
    void usesCallerEventIdAndTimeOrGeneratesThem() {
        String explicit = encode("order_paid", true, email().eventId(" order-1 ")
                .occurredAt(OffsetDateTime.parse("2026-09-13T08:15:30.250999+07:00").toInstant()).build(), null);
        assertTrue(explicit.contains("\"event_id\":\"order-1\",\"occurred_at\":\"2026-09-13T01:15:30.250Z\""), explicit);

        PayloadEncoder real = new PayloadEncoder();
        Instant before = Instant.now().minusSeconds(1);
        Map<?, ?> first = (Map<?, ?>) Json.parse(new String(real.encode("user_login", true, email().eventId(" ").build(), null),
                StandardCharsets.UTF_8));
        Map<?, ?> second = (Map<?, ?>) Json.parse(new String(real.encode("user_login", true, email().build(), null), StandardCharsets.UTF_8));
        assertTrue(((String) first.get("event_id")).matches(UUID_V4));
        assertNotEquals(first.get("event_id"), second.get("event_id"));
        Instant occurred = Instant.parse((String) first.get("occurred_at"));
        assertTrue(occurred.isAfter(before) && occurred.isBefore(Instant.now().plusSeconds(1)));
        assertMessage("occurredAt", () -> encode("user_login", true, email().occurredAt(Instant.parse("+10000-01-01T00:00:00Z")).build(), null));
    }

    @Test
    void acceptsSafeNumbersNestedContainersAndRepeatedReferences() {
        Map<String, Object> shared = Map.of("value", "reused");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("byte", (byte) 1);
        properties.put("max", 9_007_199_254_740_991L);
        properties.put("big", new BigInteger("-9007199254740991"));
        properties.put("decimal", new BigDecimal("12.50"));
        properties.put("float", 1.1f);
        properties.put("list", List.of());
        properties.put("first", shared);
        properties.put("second", shared);
        assertTrue(encode("user_login", true, email().properties(properties).build(), null).endsWith(
                "\"properties\":{\"byte\":1,\"max\":9007199254740991,\"big\":-9007199254740991,\"decimal\":12.50,\"float\":1.1,"
                + "\"list\":[],\"first\":{\"value\":\"reused\"},\"second\":{\"value\":\"reused\"}}}"));
    }

    static Stream<Arguments> invalidProperties() {
        Map<Object, Object> nonStringKey = new HashMap<>();
        nonStringKey.put(1, "one");
        return Stream.of(
                Arguments.of(Map.of("risk", Double.NaN), "properties.risk"),
                Arguments.of(Map.of("risk", Float.POSITIVE_INFINITY), "properties.risk"),
                Arguments.of(Map.of("id", 9_007_199_254_740_992L), "properties.id"),
                Arguments.of(Map.of("id", new BigInteger("9007199254740992")), "properties.id"),
                Arguments.of(Map.of("id", 9_007_199_254_740_992.0), "properties.id"),
                Arguments.of(Map.of("id", new BigDecimal("9007199254740992.000")), "properties.id"),
                Arguments.of(Map.of("order", Map.of("items", List.of(1, Long.MIN_VALUE))), "properties.order.items[1]"),
                Arguments.of(Map.of("map", nonStringKey), "non-String key"),
                Arguments.of(Map.of("array", new int[] {1}), "properties.array"),
                Arguments.of(Map.of("when", Instant.now()), "properties.when"),
                Arguments.of(Map.of("text", "\ud800"), "valid Unicode"));
    }

    @ParameterizedTest
    @MethodSource("invalidProperties")
    void rejectsNonPortableProperties(Map<String, Object> properties, String message) {
        ValidationException error = assertThrows(ValidationException.class,
                () -> encode("order_paid", true, email().properties(properties).build(), null));
        assertTrue(error.getMessage().contains(message), error.getMessage());
        assertFalse(error.getMessage().contains("NaN") || error.getMessage().contains("9007199254740992"), error.getMessage());
    }

    @Test
    void rejectsCycles() {
        Map<String, Object> cycle = new HashMap<>();
        cycle.put("self", cycle);
        List<Object> listCycle = new ArrayList<>();
        listCycle.add(listCycle);
        assertMessage("cycle", () -> encode("order_paid", true, email().property("value", cycle).build(), null));
        assertMessage("cycle", () -> encode("order_paid", true, email().property("items", listCycle).build(), null));
    }

    @Test
    void mergesOrderPaidPropertiesWithoutMutatingInput() {
        Event event = email().property("order_id", "ord-1").build();
        Event merged = PayloadEncoder.withOrderPaidProperties(new BigDecimal("125000"), " IDR ", event);
        assertTrue(encode("order_paid", true, merged, null).endsWith("\"properties\":{\"order_id\":\"ord-1\",\"amount\":125000,\"currency\":\" IDR \"}}"));
        assertEquals(Map.of("order_id", "ord-1"), event.properties());
        assertTrue(encode("order_paid", true, PayloadEncoder.withOrderPaidProperties(12.5, "USD", email().build()), null)
                .endsWith("\"properties\":{\"amount\":12.5,\"currency\":\"USD\"}}"));
    }

    @Test
    void rejectsInvalidOrderPaidArguments() {
        assertMessage("amount", () -> PayloadEncoder.withOrderPaidProperties(Double.NaN, "IDR", email().build()));
        assertMessage("amount", () -> PayloadEncoder.withOrderPaidProperties(null, "IDR", email().build()));
        assertMessage("currency", () -> PayloadEncoder.withOrderPaidProperties(1, " ", email().build()));
        assertMessage("\"amount\"", () -> PayloadEncoder.withOrderPaidProperties(1, "IDR", email().property("amount", 2).build()));
        assertMessage("\"currency\"", () -> PayloadEncoder.withOrderPaidProperties(1, "IDR", email().property("currency", "USD").build()));
        assertMessage("properties.amount", () -> encode("order_paid", true, PayloadEncoder.withOrderPaidProperties(1e16, "IDR", email().build()), null));
    }

    private static void assertMessage(String message, org.junit.jupiter.api.function.Executable executable) {
        ValidationException error = assertThrows(ValidationException.class, executable);
        assertTrue(error.getMessage().contains(message), error.getMessage());
    }
}
