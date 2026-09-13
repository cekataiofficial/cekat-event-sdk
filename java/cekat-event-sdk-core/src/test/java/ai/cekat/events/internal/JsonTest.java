package ai.cekat.events.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class JsonTest {
    @Test
    void writesEscapedStringsNumbersAndContainersInOrder() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("text", "quote\" slash\\ newline\n tab\t control\u0001 unicode é 😀");
        value.put("numbers", Arrays.asList(1, 2.5, new BigDecimal("1E+3"), null, true));
        value.put("empty", Map.of());
        assertEquals("{\"text\":\"quote\\\" slash\\\\ newline\\n tab\\t control\\u0001 unicode é 😀\","
                + "\"numbers\":[1,2.5,1E+3,null,true],\"empty\":{}}", Json.write(value));
    }

    @Test
    void parsesNestedValuesWithEscapesAndSurrogatePairs() {
        Object parsed = Json.parse(" {\"a\":[1,-2.5e3,true,false,null],\"b\":\"x\\u00e9\\ud83d\\ude00\\/\\n\",\"c\":{}} ");
        Map<String, Object> expected = new LinkedHashMap<>();
        expected.put("a", new ArrayList<>(Arrays.asList(new BigDecimal("1"), new BigDecimal("-2.5e3"), true, false, null)));
        expected.put("b", "xé😀/\n");
        expected.put("c", new LinkedHashMap<>());
        assertEquals(expected, parsed);
        assertEquals(List.of(), Json.parse("[]"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "{", "{not-json", "[1,]", "{\"a\":1,}", "01", "1.", "-", "\"unterminated", "\"\\x\"",
        "\"\\u12\"", "tru", "{\"a\" 1}", "[1] 2", "\"control\u0001\"", "{1:2}"})
    void rejectsInvalidJson(String text) {
        assertThrows(IllegalArgumentException.class, () -> Json.parse(text));
    }

    @Test
    void rejectsExcessiveNesting() {
        assertThrows(IllegalArgumentException.class, () -> Json.parse("[".repeat(600) + "]".repeat(600)));
    }
}
