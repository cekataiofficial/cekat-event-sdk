package ai.cekat.events.stripe;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import ai.cekat.events.VisitorContext;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class StripeMetadataTest {
    @Test
    void validatesAndTrimsExplicitVisitors() {
        assertEquals(Map.of("cekat_visitor_id", "visitor_A-1"), StripeMetadata.forVisitor(" visitor_A-1 "));
        assertEquals(Map.of("cekat_visitor_id", "a"), StripeMetadata.forVisitor("a"));
        assertEquals(Map.of("cekat_visitor_id", "a".repeat(128)), StripeMetadata.forVisitor("a".repeat(128)));
        assertEquals(Map.of(), StripeMetadata.forVisitor("a".repeat(129)));
        assertEquals(Map.of(), StripeMetadata.forVisitor("invalid visitor"));
    }

    @Test
    void readsCurrentVisitorAndReturnsIndependentImmutableMerges() {
        try (VisitorContext.Scope ignored = VisitorContext.open(" scoped ")) {
            assertEquals(Map.of("cekat_visitor_id", "scoped"), StripeMetadata.fromCurrentVisitor());
        }
        assertEquals(Map.of(), StripeMetadata.fromCurrentVisitor());

        Map<String, String> merchant = new LinkedHashMap<>(Map.of("merchant", "keep", "cekat_visitor_id", "replace"));
        Map<String, String> merged = StripeMetadata.mergeMetadata(merchant, " visitor_2 ");
        assertEquals(Map.of("merchant", "keep", "cekat_visitor_id", "visitor_2"), merged);
        assertEquals("replace", merchant.get("cekat_visitor_id"));
        assertThrows(UnsupportedOperationException.class, () -> merged.put("merchant", "changed"));
        assertEquals(merchant, StripeMetadata.mergeMetadata(merchant, "invalid visitor"));
    }
}
