package ai.cekat.events.internal;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.cekat.events.Acknowledgement;
import ai.cekat.events.error.ApiException;
import ai.cekat.events.error.AuthenticationException;
import ai.cekat.events.error.EventDefinitionNotFoundException;
import ai.cekat.events.error.ResponseDecodeException;
import ai.cekat.events.support.FakeTransport;
import ai.cekat.events.transport.TransportResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class ResponseDecoderTest {
    @Test
    void decodesStrictSuccessEnvelope() {
        String body = "{\"success\":true,\"data\":{\"success\":true,\"message\":\"accepted\",\"event_key\":\"order_paid\","
                + "\"validated_properties\":[\"order_id\"],\"extra\":1}}";
        Acknowledgement ack = ResponseDecoder.decode(FakeTransport.response(200, body), 2);
        assertTrue(ack.success());
        assertEquals("accepted", ack.message());
        assertEquals("order_paid", ack.eventKey());
        assertEquals(List.of("order_id"), ack.validatedProperties());
        assertEquals(body, ack.rawBodyText());
        byte[] copy = ack.rawBody();
        copy[0] = 'x';
        assertEquals('{', ack.rawBody()[0]);
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "{not-json",
        "{\"success\":false,\"data\":{\"success\":true,\"message\":\"a\",\"event_key\":\"k\",\"validated_properties\":[]}}",
        "{\"success\":true,\"data\":[]}",
        "{\"success\":true,\"data\":{\"message\":\"a\",\"event_key\":\"k\",\"validated_properties\":[]}}",
        "{\"success\":true,\"data\":{\"success\":true,\"message\":\"\",\"event_key\":\"k\",\"validated_properties\":[]}}",
        "{\"success\":true,\"data\":{\"success\":true,\"message\":\"a\",\"event_key\":\"\",\"validated_properties\":[]}}",
        "{\"success\":true,\"data\":{\"success\":true,\"message\":\"a\",\"event_key\":\"k\",\"validated_properties\":{}}}",
        "{\"success\":true,\"data\":{\"success\":true,\"message\":\"a\",\"event_key\":\"k\",\"validated_properties\":[1]}}"
    })
    void malformedSuccessIsDecodeError(String body) {
        ResponseDecodeException error = assertThrows(ResponseDecodeException.class,
                () -> ResponseDecoder.decode(FakeTransport.response(200, body), 1));
        assertArrayEquals(body.getBytes(StandardCharsets.UTF_8), error.rawBody());
        assertEquals(200, error.statusCode());
        assertEquals(1, error.attempts());
        assertFalse(error.deliveryOutcomeUnknown());
    }

    @Test
    void truncatedOrUnreadableSuccessIsDecodeError() {
        TransportResponse truncated = new TransportResponse(200, Map.of(), new byte[65_536], true, 65_537, null);
        assertTrue(assertThrows(ResponseDecodeException.class, () -> ResponseDecoder.decode(truncated, 1)).getMessage().contains("exceeds"));
        RuntimeException reset = new RuntimeException("reset");
        ResponseDecodeException unreadable = assertThrows(ResponseDecodeException.class,
                () -> ResponseDecoder.decode(FakeTransport.response(200, "{\"success\":tr", Map.of(), reset), 1));
        assertSame(reset, unreadable.getCause());
    }

    @Test
    void mapsStructuredErrorsToTypedExceptions() {
        String body = "{\"success\":false,\"error\":\"defined server error\",\"code\":\"fixture_code\"}";
        Map<Integer, Class<?>> types = Map.of(400, ApiException.class, 401, AuthenticationException.class,
                404, EventDefinitionNotFoundException.class, 422, ApiException.class);
        types.forEach((status, type) -> {
            ApiException error = assertThrows(ApiException.class, () -> ResponseDecoder.decode(FakeTransport.response(status, body), 3));
            assertEquals(type, error.getClass());
            assertEquals("defined server error", error.getMessage());
            assertEquals(Optional.of("fixture_code"), error.serverCode());
            assertEquals(status, error.statusCode());
            assertEquals(3, error.attempts());
            assertFalse(error.deliveryOutcomeUnknown());
        });
        assertEquals(Optional.empty(), assertThrows(ApiException.class,
                () -> ResponseDecoder.decode(FakeTransport.response(400, "{\"success\":false,\"error\":\"no code\"}"), 1)).serverCode());
    }

    @Test
    void malformedErrorsUseStatusText() {
        assertEquals("I'm a teapot", message(418, "not json"));
        assertEquals("Gateway Timeout", message(504, "{\"success\":false,\"error\":\"x\",\"code\":null}"));
        assertEquals("Bad Request", message(400, "{\"success\":false,\"error\":\"\"}"));
        assertEquals("HTTP 599", message(599, ""));
    }

    private static String message(int status, String body) {
        return assertThrows(ApiException.class, () -> ResponseDecoder.decode(FakeTransport.response(status, body), 1)).getMessage();
    }
}
