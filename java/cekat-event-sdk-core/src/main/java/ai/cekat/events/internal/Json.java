package ai.cekat.events.internal;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal RFC 8259 JSON writer and parser, so the core has no runtime dependencies. Not public API.
 *
 * <p>The writer accepts only values already normalized by {@link PayloadEncoder}. The parser returns
 * {@link LinkedHashMap}, {@link ArrayList}, {@link String}, {@link BigDecimal}, {@link Boolean}, or {@code null}.
 */
public final class Json {
    private static final int MAX_DEPTH = 512;

    private Json() {
    }

    /**
     * Serializes a normalized value.
     *
     * @param value map, list, string, number, boolean, or {@code null}
     * @return JSON text
     */
    public static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(value, out);
        return out.toString();
    }

    private static void write(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String text) {
            writeString(text, out);
        } else if (value instanceof Boolean || value instanceof Number) {
            out.append(value);
        } else if (value instanceof Map<?, ?> map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                writeString((String) entry.getKey(), out);
                out.append(':');
                write(entry.getValue(), out);
            }
            out.append('}');
        } else if (value instanceof List<?> list) {
            out.append('[');
            for (int index = 0; index < list.size(); index++) {
                if (index > 0) {
                    out.append(',');
                }
                write(list.get(index), out);
            }
            out.append(']');
        } else {
            throw new IllegalArgumentException("unsupported JSON value type " + value.getClass().getName());
        }
    }

    private static void writeString(String text, StringBuilder out) {
        out.append('"');
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            switch (character) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                default -> {
                    if (character < 0x20) {
                        out.append(String.format("\\u%04x", (int) character));
                    } else {
                        out.append(character);
                    }
                }
            }
        }
        out.append('"');
    }

    /**
     * Parses JSON text.
     *
     * @param text JSON text
     * @return the parsed value
     * @throws IllegalArgumentException when the text is not a single valid JSON value
     */
    public static Object parse(String text) {
        Parser parser = new Parser(text);
        parser.skipWhitespace();
        Object value = parser.value(0);
        parser.skipWhitespace();
        if (parser.position != text.length()) {
            throw parser.error("trailing content");
        }
        return value;
    }

    private static final class Parser {
        private final String text;
        private int position;

        Parser(String text) {
            this.text = text;
        }

        Object value(int depth) {
            if (depth > MAX_DEPTH) {
                throw error("nesting too deep");
            }
            if (position >= text.length()) {
                throw error("unexpected end of input");
            }
            char character = text.charAt(position);
            return switch (character) {
                case '{' -> object(depth);
                case '[' -> array(depth);
                case '"' -> string();
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> {
                    if (character == '-' || (character >= '0' && character <= '9')) {
                        yield number();
                    }
                    throw error("unexpected character");
                }
            };
        }

        private Map<String, Object> object(int depth) {
            Map<String, Object> result = new LinkedHashMap<>();
            position++;
            skipWhitespace();
            if (peek('}')) {
                position++;
                return result;
            }
            while (true) {
                skipWhitespace();
                if (!peek('"')) {
                    throw error("expected object key");
                }
                String key = string();
                skipWhitespace();
                expect(':');
                skipWhitespace();
                result.put(key, value(depth + 1));
                skipWhitespace();
                if (peek(',')) {
                    position++;
                    continue;
                }
                expect('}');
                return result;
            }
        }

        private List<Object> array(int depth) {
            List<Object> result = new ArrayList<>();
            position++;
            skipWhitespace();
            if (peek(']')) {
                position++;
                return result;
            }
            while (true) {
                skipWhitespace();
                result.add(value(depth + 1));
                skipWhitespace();
                if (peek(',')) {
                    position++;
                    continue;
                }
                expect(']');
                return result;
            }
        }

        private String string() {
            position++;
            StringBuilder out = new StringBuilder();
            while (true) {
                if (position >= text.length()) {
                    throw error("unterminated string");
                }
                char character = text.charAt(position++);
                if (character == '"') {
                    return out.toString();
                }
                if (character < 0x20) {
                    throw error("control character in string");
                }
                if (character != '\\') {
                    out.append(character);
                    continue;
                }
                if (position >= text.length()) {
                    throw error("unterminated escape");
                }
                char escape = text.charAt(position++);
                switch (escape) {
                    case '"' -> out.append('"');
                    case '\\' -> out.append('\\');
                    case '/' -> out.append('/');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'u' -> {
                        if (position + 4 > text.length()) {
                            throw error("short unicode escape");
                        }
                        try {
                            out.append((char) Integer.parseInt(text.substring(position, position + 4), 16));
                        } catch (NumberFormatException invalid) {
                            throw error("invalid unicode escape");
                        }
                        position += 4;
                    }
                    default -> throw error("invalid escape");
                }
            }
        }

        private BigDecimal number() {
            int start = position;
            if (peek('-')) {
                position++;
            }
            if (peek('0')) {
                position++;
            } else if (digit()) {
                digits();
            } else {
                throw error("invalid number");
            }
            if (peek('.')) {
                position++;
                if (!digit()) {
                    throw error("invalid fraction");
                }
                digits();
            }
            if (peek('e') || peek('E')) {
                position++;
                if (peek('+') || peek('-')) {
                    position++;
                }
                if (!digit()) {
                    throw error("invalid exponent");
                }
                digits();
            }
            return new BigDecimal(text.substring(start, position));
        }

        private Object literal(String word, Object result) {
            if (!text.startsWith(word, position)) {
                throw error("invalid literal");
            }
            position += word.length();
            return result;
        }

        void skipWhitespace() {
            while (position < text.length()) {
                char character = text.charAt(position);
                if (character != ' ' && character != '\t' && character != '\n' && character != '\r') {
                    return;
                }
                position++;
            }
        }

        private boolean peek(char expected) {
            return position < text.length() && text.charAt(position) == expected;
        }

        private boolean digit() {
            return position < text.length() && Character.isDigit(text.charAt(position)) && text.charAt(position) <= '9';
        }

        private void digits() {
            while (digit()) {
                position++;
            }
        }

        private void expect(char expected) {
            if (!peek(expected)) {
                throw error("expected '" + expected + "'");
            }
            position++;
        }

        IllegalArgumentException error(String message) {
            return new IllegalArgumentException("invalid JSON at offset " + position + ": " + message);
        }
    }
}
