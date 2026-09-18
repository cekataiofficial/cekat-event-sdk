package ai.cekat.events.stripe;

import ai.cekat.events.VisitorContext;
import java.util.LinkedHashMap;
import java.util.Map;

public final class StripeMetadata {
    private static final String VISITOR_METADATA_KEY = "cekat_visitor_id";

    private StripeMetadata() {
    }

    public static Map<String, String> forVisitor(String visitorId) {
        String normalized = validVisitorId(visitorId);
        return normalized == null ? Map.of() : Map.of(VISITOR_METADATA_KEY, normalized);
    }

    public static Map<String, String> fromCurrentVisitor() {
        return forVisitor(VisitorContext.currentVisitorId().orElse(null));
    }

    public static Map<String, String> mergeMetadata(Map<String, String> metadata, String visitorId) {
        LinkedHashMap<String, String> merged = new LinkedHashMap<>(metadata);
        String normalized = validVisitorId(visitorId);
        if (normalized != null) {
            merged.put(VISITOR_METADATA_KEY, normalized);
        }
        return Map.copyOf(merged);
    }

    private static String validVisitorId(String visitorId) {
        if (visitorId == null) {
            return null;
        }
        String normalized = visitorId.strip();
        if (normalized.isEmpty() || normalized.length() > 128) {
            return null;
        }
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (!(character >= 'a' && character <= 'z')
                    && !(character >= 'A' && character <= 'Z')
                    && !(character >= '0' && character <= '9')
                    && character != '_' && character != '-') {
                return null;
            }
        }
        return normalized;
    }
}
