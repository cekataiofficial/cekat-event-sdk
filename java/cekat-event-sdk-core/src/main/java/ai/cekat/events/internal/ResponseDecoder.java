package ai.cekat.events.internal;

import ai.cekat.events.Acknowledgement;
import ai.cekat.events.error.ApiException;
import ai.cekat.events.error.AuthenticationException;
import ai.cekat.events.error.EventDefinitionNotFoundException;
import ai.cekat.events.error.ResponseDecodeException;
import ai.cekat.events.transport.TransportResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** Maps a received response to an acknowledgement or a typed exception. Not public API. */
public final class ResponseDecoder {
    private ResponseDecoder() {
    }

    /**
     * Decodes a response.
     *
     * @param response received response
     * @param attempts attempts made
     * @return the acknowledgement for a valid 200
     */
    public static Acknowledgement decode(TransportResponse response, int attempts) {
        byte[] body = response.body();
        if (response.statusCode() == 200) {
            return acknowledgement(response, body, attempts);
        }
        String text = new String(body, StandardCharsets.UTF_8);
        String message = HttpStatusText.forStatus(response.statusCode());
        String code = null;
        Object parsed = parseOrNull(text);
        if (parsed instanceof Map<?, ?> envelope && Boolean.FALSE.equals(envelope.get("success"))
                && envelope.get("error") instanceof String error && !error.isEmpty()
                && (!envelope.containsKey("code") || envelope.get("code") instanceof String)) {
            message = error;
            code = (String) envelope.get("code");
        }
        throw switch (response.statusCode()) {
            case 401 -> new AuthenticationException(message, code, body, attempts);
            case 404 -> new EventDefinitionNotFoundException(message, code, body, attempts);
            default -> new ApiException(message, response.statusCode(), code, body, attempts);
        };
    }

    private static Acknowledgement acknowledgement(TransportResponse response, byte[] body, int attempts) {
        if (response.bodyReadFailure() != null) {
            throw new ResponseDecodeException("response body could not be read", body, attempts, response.bodyReadFailure());
        }
        if (response.bodyTruncated()) {
            throw new ResponseDecodeException("response body exceeds 65536 bytes", body, attempts, null);
        }
        Object parsed;
        try {
            parsed = Json.parse(new String(body, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException invalid) {
            throw new ResponseDecodeException("response body is not valid JSON", body, attempts, invalid);
        }
        if (parsed instanceof Map<?, ?> envelope && Boolean.TRUE.equals(envelope.get("success"))
                && envelope.get("data") instanceof Map<?, ?> data && Boolean.TRUE.equals(data.get("success"))
                && data.get("message") instanceof String message && !message.isEmpty()
                && data.get("event_key") instanceof String eventKey && !eventKey.isEmpty()
                && data.get("validated_properties") instanceof List<?> properties
                && properties.stream().allMatch(String.class::isInstance)) {
            return new Acknowledgement(message, eventKey, properties.stream().map(String.class::cast).toList(), body);
        }
        throw new ResponseDecodeException("response body is not a valid success envelope", body, attempts, null);
    }

    private static Object parseOrNull(String text) {
        try {
            return Json.parse(text);
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }
}
