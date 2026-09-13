package ai.cekat.events;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;

class VisitorContextTest {
    private static VisitorRequest request(String header, String cookie) {
        return new VisitorRequest() {
            @Override
            public Optional<String> firstHeader(String name) {
                return Optional.ofNullable(header);
            }

            @Override
            public Optional<String> cookie(String name) {
                return Optional.ofNullable(cookie);
            }
        };
    }

    @Test
    void headerWinsAndNestedScopesRestore() {
        assertTrue(VisitorContext.currentVisitorId().isEmpty());
        try (VisitorContext.Scope outer = VisitorContext.open(request("  header-id  ", "cookie-id"))) {
            assertEquals("header-id", VisitorContext.currentVisitorId().orElseThrow());
            try (VisitorContext.Scope inner = VisitorContext.open(" explicit ")) {
                assertEquals("explicit", VisitorContext.currentVisitorId().orElseThrow());
                try (VisitorContext.Scope blank = VisitorContext.open(" ")) {
                    assertTrue(VisitorContext.currentVisitorId().isEmpty());
                }
            }
            assertEquals("header-id", VisitorContext.currentVisitorId().orElseThrow());
        }
        assertTrue(VisitorContext.currentVisitorId().isEmpty());
    }

    @Test
    void blankHeaderFallsBackToCookieAndCloseIsIdempotent() {
        assertEquals(Optional.of("cookie-id"), VisitorContext.resolve(request(" \t", " cookie-id ")));
        assertEquals(Optional.empty(), VisitorContext.resolve(request(" ", " ")));
        VisitorContext.Scope scope = VisitorContext.open("once");
        scope.close();
        try (VisitorContext.Scope other = VisitorContext.open("other")) {
            scope.close();
            assertEquals("other", VisitorContext.currentVisitorId().orElseThrow());
        }
    }

    @Test
    void exceptionsRestoreAndOtherThreadsDoNotInherit() throws Exception {
        assertThrows(IllegalStateException.class, () -> {
            try (VisitorContext.Scope ignored = VisitorContext.open("failing")) {
                throw new IllegalStateException("boom");
            }
        });
        assertTrue(VisitorContext.currentVisitorId().isEmpty());

        ExecutorService executor = Executors.newSingleThreadExecutor();
        try (VisitorContext.Scope ignored = VisitorContext.open("request")) {
            assertEquals(Optional.empty(), executor.submit(VisitorContext::currentVisitorId).get());
            assertEquals(Optional.empty(), CompletableFuture.supplyAsync(VisitorContext::currentVisitorId).get());
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void parsesRawCookieHeadersWithoutDecoding() {
        assertEquals(Optional.of("a%20b"), VisitorContext.fromCookieHeader("x_cekat_visitor_id=no; _cekat_visitor_id=a%20b"));
        assertEquals(Optional.of("second"), VisitorContext.fromCookieHeader("_cekat_visitor_id= ; _cekat_visitor_id= second "));
        assertEquals(Optional.empty(), VisitorContext.fromCookieHeader("malformed; other=1"));
        assertEquals(Optional.empty(), VisitorContext.fromCookieHeader(null));
        assertEquals(Map.of(), Map.of());
    }
}
