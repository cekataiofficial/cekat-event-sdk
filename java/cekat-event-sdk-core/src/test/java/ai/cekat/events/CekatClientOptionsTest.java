package ai.cekat.events;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.cekat.events.error.ValidationException;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

class CekatClientOptionsTest {
    @Test
    void defaultsAndOriginNormalization() {
        CekatClientOptions defaults = CekatClientOptions.defaults();
        assertEquals(URI.create("https://t.cekat.ai"), defaults.baseUrl());
        assertEquals(URI.create("https://t.cekat.ai/api/events/ingest"), defaults.ingestUri());
        assertEquals(Duration.ofSeconds(3), defaults.timeout());
        assertEquals(2, defaults.retryCount());
        assertEquals(URI.create("http://127.0.0.1:8080/api/events/ingest"),
                CekatClientOptions.builder().baseUrl("HTTP://127.0.0.1:8080/").build().ingestUri());
        assertEquals(URI.create("https://[::1]:8443/api/events/ingest"),
                CekatClientOptions.builder().baseUrl("https://[::1]:8443").build().ingestUri());
    }

    @Test
    void rejectsInvalidOptionsWithoutEchoingTokens() {
        for (String baseUrl : List.of("t.cekat.ai", "ftp://t.cekat.ai", "https://user:secret-token@t.cekat.ai",
                "https://t.cekat.ai/events", "https://t.cekat.ai/root/", "https://t.cekat.ai/?q=1",
                "https://t.cekat.ai/#frag", "https://", "not a uri")) {
            ValidationException error = assertThrows(ValidationException.class, () -> CekatClientOptions.builder().baseUrl(baseUrl).build());
            assertTrue(error.getMessage().contains("base URL") && !error.getMessage().contains("secret-token"), baseUrl);
        }
        assertThrows(ValidationException.class, () -> CekatClientOptions.builder().baseUrl((URI) null).build());
        assertThrows(ValidationException.class, () -> CekatClientOptions.builder().timeout(Duration.ZERO).build());
        assertThrows(ValidationException.class, () -> CekatClientOptions.builder().timeout(Duration.ofSeconds(-1)).build());
        assertThrows(ValidationException.class, () -> CekatClientOptions.builder().retryCount(-1).build());
        assertThrows(ValidationException.class, () -> new CekatClient(" \t"));
        assertThrows(ValidationException.class, () -> new CekatClient("token", null));
    }
}
