package ai.cekat.events.conformance;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import ai.cekat.events.Acknowledgement;
import ai.cekat.events.CekatClient;
import ai.cekat.events.CekatClientOptions;
import ai.cekat.events.Event;
import ai.cekat.events.VisitorContext;
import ai.cekat.events.VisitorRequest;
import ai.cekat.events.error.ApiException;
import ai.cekat.events.error.AuthenticationException;
import ai.cekat.events.error.CekatException;
import ai.cekat.events.error.EventDefinitionNotFoundException;
import ai.cekat.events.error.ResponseDecodeException;
import ai.cekat.events.error.TransportException;
import ai.cekat.events.error.ValidationException;
import ai.cekat.events.transport.HttpTransport;
import ai.cekat.events.transport.JdkHttpTransport;
import ai.cekat.events.transport.TransportResponse;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/** Executes every shared fixture against the mock ingest server using only the public Java API. */
class SharedConformanceTest {
    private static final String SCHEMA_BASE = "https://schemas.cekat.ai/event-sdk/conformance/";
    private static final List<String> PROPERTIES = List.of(
            "cekat.conformance.baseUrl", "cekat.conformance.controlUrl", "cekat.conformance.accessToken", "cekat.conformance.fixtures");
    private static final Pattern EVENT_ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static final Pattern OCCURRED_AT = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z");
    private static final Pattern USER_AGENT = Pattern.compile("cekat-event-sdk-java/\\d+\\.\\d+\\.\\d+\\S*( .+)?");
    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    private static final HttpClient CONTROL = HttpClient.newHttpClient();

    private static SchemaRegistry registry(Path schemaDirectory) throws IOException {
        Map<String, String> schemas = new HashMap<>();
        try (Stream<Path> files = Files.list(schemaDirectory)) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".schema.json")).toList()) {
                schemas.put(SCHEMA_BASE + file.getFileName(), Files.readString(file));
            }
        }
        return SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12, builder -> builder.schemas(schemas));
    }

    private static Schema schema(SchemaRegistry registry, String name) {
        return registry.getSchema(SchemaLocation.of(SCHEMA_BASE + name));
    }

    @Test
    void schemasRejectMalformedFixtures() throws Exception {
        Path fixtures = Path.of("..", "..", "conformance", "fixtures").toAbsolutePath().normalize();
        Schema caseSchema = schema(registry(fixtures.resolve("schemas")), "conformance-case.schema.json");
        JsonNode fixture = MAPPER.readTree(fixtures.resolve("cases/retry-500-500-success.json").toFile());
        assertTrue(caseSchema.validate(fixture).isEmpty());
        List<java.util.function.Consumer<ObjectNode>> mutations = List.of(
                node -> ((ObjectNode) node.get("responses").get(0)).put("headers", 1),
                node -> ((ObjectNode) node.get("expect")).put("status", "400"),
                node -> ((ObjectNode) node.get("expect").get("request")).put("extra", true),
                node -> ((ObjectNode) node.get("operation")).remove("currency"),
                node -> ((ObjectNode) node.get("expect")).set("jitter_bounds_ms", MAPPER.readTree("[[0,101],[0,200]]")));
        for (java.util.function.Consumer<ObjectNode> mutation : mutations) {
            ObjectNode invalid = (ObjectNode) fixture.deepCopy();
            mutation.accept(invalid);
            assertFalse(caseSchema.validate(invalid).isEmpty());
        }
    }

    @Test
    void executesEveryDiscoveredFixtureExactlyOnce() throws Exception {
        Map<String, String> env = new HashMap<>();
        for (String name : PROPERTIES) {
            env.put(name, Optional.ofNullable(System.getProperty(name)).orElse(""));
        }
        Assumptions.assumeFalse(env.values().stream().allMatch(String::isBlank), "run java/scripts/conformance to configure the mock server");
        List<String> missing = env.entrySet().stream().filter(entry -> entry.getValue().isBlank()).map(Map.Entry::getKey).sorted().toList();
        assertTrue(missing.isEmpty(), "missing conformance inputs: " + missing);

        Path directory = Path.of(env.get("cekat.conformance.fixtures"));
        assertTrue(directory.isAbsolute() && Files.isDirectory(directory), "fixtures must be an absolute directory");
        SchemaRegistry registry = registry(directory.getParent().resolve("schemas"));
        Schema caseSchema = schema(registry, "conformance-case.schema.json");
        Schema journalSchema = schema(registry, "request-journal.schema.json");

        List<Path> files;
        try (Stream<Path> listing = Files.list(directory)) {
            files = listing.filter(path -> path.getFileName().toString().endsWith(".json")).sorted().toList();
        }
        assertFalse(files.isEmpty(), "fixture corpus contains no direct JSON files");
        Set<String> discovered = new HashSet<>();
        Set<String> passed = new HashSet<>();
        for (Path file : files) {
            JsonNode fixture = MAPPER.readTree(file.toFile());
            assertTrue(caseSchema.validate(fixture).isEmpty(), file.getFileName() + " violates the shared schema: " + caseSchema.validate(fixture));
            String id = fixture.get("id").asString();
            assertEquals(file.getFileName().toString().replaceFirst("\\.json$", ""), id, "filename/ID mismatch");
            assertTrue(discovered.add(id), "duplicate fixture ID " + id);
            JsonNode inapplicable = fixture.path("applicability").path("inapplicable_languages");
            for (JsonNode language : inapplicable) {
                assertFalse("java".equals(language.asString()), id + " must not exclude java: Java supports caller cancellation");
            }
            new Case(fixture, env, journalSchema).run();
            passed.add(id);
            System.out.println("{\"id\":\"" + id + "\",\"status\":\"passed\"}");
        }
        assertEquals(discovered, passed);
    }

    /** One fixture execution. */
    private static final class Case {
        private final JsonNode fixture;
        private final JsonNode expect;
        private final String id;
        private final Map<String, String> env;
        private final Schema journalSchema;
        private final List<Long> sleeps = new ArrayList<>();
        private final AtomicReference<TransportResponse> last = new AtomicReference<>();

        Case(JsonNode fixture, Map<String, String> env, Schema journalSchema) {
            this.fixture = fixture;
            this.expect = fixture.get("expect");
            this.id = fixture.get("id").asString();
            this.env = env;
            this.journalSchema = journalSchema;
        }

        void run() throws Exception {
            control("POST", "/__control/reset", null);
            ObjectNode queue = MAPPER.createObjectNode();
            JsonNode responses = fixture.has("responses") ? fixture.get("responses").deepCopy() : MAPPER.createArrayNode();
            String expanded = null;
            if (fixture.has("response_body_recipe")) {
                JsonNode recipe = fixture.get("response_body_recipe");
                StringBuilder body = new StringBuilder();
                while (body.toString().getBytes(StandardCharsets.UTF_8).length < recipe.get("minimum_utf8_bytes").asInt()) {
                    body.append(recipe.get("unit").asString());
                }
                expanded = body.append(recipe.get("suffix").asString()).toString();
                assertEquals(1, responses.size());
                ((ObjectNode) responses.get(0)).put("body", expanded);
            }
            queue.set("responses", responses);
            control("POST", "/__control/responses", MAPPER.writeValueAsString(queue));

            String phase = fixture.path("cancellation").path("phase").asString("");
            JdkHttpTransport real = new JdkHttpTransport();
            HttpTransport transport = request -> {
                TransportResponse response = real.execute(request);
                last.set(response);
                if ("during_backoff".equals(phase) && response.statusCode() == 500) {
                    Thread.currentThread().interrupt();
                }
                return response;
            };
            JsonNode client = fixture.path("client");
            CekatClient sdk = new CekatClient(env.get("cekat.conformance.accessToken"), CekatClientOptions.builder()
                    .baseUrl(env.get("cekat.conformance.baseUrl"))
                    .timeout(client.has("timeout_ms") ? Duration.ofMillis(client.get("timeout_ms").asLong()) : CekatClientOptions.DEFAULT_TIMEOUT)
                    .retryCount(client.has("retry_count") ? client.get("retry_count").asInt() : CekatClientOptions.DEFAULT_RETRY_COUNT)
                    .transport(transport)
                    .jitter(bound -> bound / 2)
                    .sleeper(duration -> {
                        sleeps.add(duration.toMillis());
                        if (Thread.interrupted()) {
                            throw new InterruptedException("cancelled during backoff");
                        }
                    }).build());

            Acknowledgement result = null;
            Throwable error = null;
            Instant started = Instant.now();
            Thread watcher = null;
            if ("before_request".equals(phase)) {
                Thread.currentThread().interrupt();
            } else if ("during_request".equals(phase)) {
                watcher = interruptWhenJournaled(Thread.currentThread());
            }
            try (VisitorContext.Scope ignored = openInbound()) {
                result = dispatch(sdk);
            } catch (CekatException | InterruptedException caught) {
                error = caught;
            } finally {
                if (watcher != null) {
                    watcher.interrupt();
                    watcher.join();
                }
                Thread.interrupted();
            }
            Instant finished = Instant.now();
            assertResult(result, error, expanded);
            assertDelays();
            assertJournal(started, finished);
        }

        private Thread interruptWhenJournaled(Thread caller) {
            Thread watcher = new Thread(() -> {
                long deadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
                while (System.nanoTime() < deadline && !Thread.currentThread().isInterrupted()) {
                    try {
                        if (!journal().get("requests").isEmpty()) {
                            caller.interrupt();
                            return;
                        }
                        Thread.sleep(2);
                    } catch (IOException | InterruptedException stopped) {
                        return;
                    }
                }
            });
            watcher.start();
            return watcher;
        }

        private VisitorContext.Scope openInbound() {
            JsonNode inbound = fixture.path("inbound");
            if (inbound.has("header_visitor_id") || inbound.has("cookie_visitor_id")) {
                return VisitorContext.open(new VisitorRequest() {
                    @Override
                    public Optional<String> firstHeader(String name) {
                        return inbound.has("header_visitor_id") ? Optional.of(inbound.get("header_visitor_id").asString()) : Optional.empty();
                    }

                    @Override
                    public Optional<String> cookie(String name) {
                        return inbound.has("cookie_visitor_id")
                                ? VisitorContext.fromCookieHeader("_cekat_visitor_id=" + inbound.get("cookie_visitor_id").asString())
                                : Optional.empty();
                    }
                });
            }
            return VisitorContext.open(inbound.has("ambient_visitor_id") ? inbound.get("ambient_visitor_id").asString() : null);
        }

        @SuppressWarnings("unchecked")
        private Acknowledgement dispatch(CekatClient sdk) throws InterruptedException {
            JsonNode operation = fixture.get("operation");
            JsonNode source = operation.get("event");
            Map<String, Object> properties = operation.has("properties_recipe")
                    ? recipe(operation.get("properties_recipe").asString())
                    : source.has("properties") ? MAPPER.convertValue(source.get("properties"), Map.class) : Map.of();
            Event event = Event.builder()
                    .email(text(source, "email")).phoneNumber(text(source, "phone_number")).contactName(text(source, "contact_name"))
                    .visitorId(text(source, "visitor_id")).eventId(text(source, "event_id"))
                    .occurredAt(source.has("occurred_at") ? OffsetDateTime.parse(source.get("occurred_at").asString()).toInstant() : null)
                    .properties(properties).build();
            return switch (operation.get("name").asString()) {
                case "user_registration" -> sdk.userRegistration(event);
                case "user_login" -> sdk.userLogin(event);
                case "order_created" -> sdk.orderCreated(event);
                case "order_paid" -> sdk.orderPaid(operation.get("amount").numberValue(), operation.get("currency").asString(), event);
                case "custom_event" -> sdk.customEvent(operation.get("event_key").asString(), event);
                default -> throw new AssertionError("unknown operation in " + id);
            };
        }

        private static String text(JsonNode node, String field) {
            return node.has(field) ? node.get(field).asString() : null;
        }

        private static Map<String, Object> recipe(String name) {
            Map<String, Object> value = new HashMap<>();
            switch (name) {
                case "nan" -> value.put("value", Double.NaN);
                case "positive_infinity" -> value.put("value", Double.POSITIVE_INFINITY);
                case "negative_infinity" -> value.put("value", Double.NEGATIVE_INFINITY);
                case "unsafe_integer_high" -> value.put("value", 9_007_199_254_740_992L);
                case "unsafe_integer_low" -> value.put("value", -9_007_199_254_740_992L);
                case "cycle" -> value.put("self", value);
                case "non_string_key" -> {
                    Map<Object, Object> nested = new HashMap<>();
                    nested.put(1, "one");
                    value.put("value", nested);
                }
                case "runtime_object" -> value.put("value", new Object());
                default -> throw new AssertionError("unknown properties recipe " + name);
            }
            return value;
        }

        private void assertResult(Acknowledgement result, Throwable error, String expanded) {
            String expected = expect.get("result").asString();
            String token = env.get("cekat.conformance.accessToken");
            if (error != null) {
                assertFalse(String.valueOf(error.getMessage()).contains(token) || String.valueOf(error.getCause()).contains(token), id);
            }
            if ("acknowledgement".equals(expected)) {
                assertNull(error, () -> id + ": " + error);
                assertNotNull(result, id);
                if (expect.has("acknowledgement")) {
                    JsonNode ack = expect.get("acknowledgement");
                    assertEquals(ack.get("message").asString(), result.message(), id);
                    assertEquals(ack.get("event_key").asString(), result.eventKey(), id);
                    assertEquals(MAPPER.convertValue(ack.get("validated_properties"), List.class), result.validatedProperties(), id);
                }
            } else {
                Class<?> type = switch (expected) {
                    case "validation_error" -> ValidationException.class;
                    case "authentication_error" -> AuthenticationException.class;
                    case "event_definition_not_found_error" -> EventDefinitionNotFoundException.class;
                    case "api_error" -> ApiException.class;
                    case "transport_error" -> TransportException.class;
                    case "response_decode_error" -> ResponseDecodeException.class;
                    case "caller_cancelled" -> InterruptedException.class;
                    default -> throw new AssertionError("unknown result form in " + id);
                };
                assertNotNull(error, () -> id + " expected " + expected);
                assertEquals(type, error.getClass(), () -> id + ": " + error);
                if (error instanceof CekatException cekat && !(error instanceof ValidationException)) {
                    assertEquals(expect.get("attempts").asInt(), cekat.attempts(), id);
                    assertEquals(expect.path("delivery_outcome_unknown").asBoolean(error instanceof TransportException), cekat.deliveryOutcomeUnknown(), id);
                }
                if (error instanceof ApiException api) {
                    if (expect.has("status")) {
                        assertEquals(expect.get("status").asInt(), api.statusCode(), id);
                    }
                    if (expect.has("error_message")) {
                        assertEquals(expect.get("error_message").asString(), api.getMessage(), id);
                    }
                    if (expect.has("server_error")) {
                        assertEquals(expect.get("server_error").asString(), api.getMessage(), id);
                    }
                    if (expect.has("server_code")) {
                        assertEquals(Optional.of(expect.get("server_code").asString()), api.serverCode(), id);
                    }
                    assertRetained(api.rawBody(), expanded);
                }
                if (error instanceof ResponseDecodeException decode) {
                    assertRetained(decode.rawBody(), expanded);
                }
            }
            if (expect.has("observed_body_bytes") || expect.has("body_truncated")) {
                assertNotNull(last.get(), id);
                assertEquals(expect.get("observed_body_bytes").asInt(), last.get().observedBodyBytes(), id);
                assertEquals(expect.get("body_truncated").asBoolean(), last.get().bodyTruncated(), id);
            }
        }

        private void assertRetained(byte[] body, String expanded) {
            if (!expect.has("retained_body_bytes")) {
                return;
            }
            int retained = expect.get("retained_body_bytes").asInt();
            assertEquals(retained, body.length, id);
            if (expanded != null) {
                assertArrayEquals(Arrays.copyOf(expanded.getBytes(StandardCharsets.UTF_8), retained), body, id);
            }
        }

        private void assertDelays() {
            if (expect.has("jitter_bounds_ms")) {
                assertEquals(expect.get("jitter_bounds_ms").size(), sleeps.size(), id);
                for (int index = 0; index < sleeps.size(); index++) {
                    JsonNode bounds = expect.get("jitter_bounds_ms").get(index);
                    long sleep = sleeps.get(index);
                    assertTrue(sleep >= bounds.get(0).asLong() && sleep <= bounds.get(1).asLong(), id + " delay " + sleep);
                }
            }
            if (expect.has("minimum_retry_delays_ms")) {
                assertEquals(expect.get("minimum_retry_delays_ms").size(), sleeps.size(), id);
                for (int index = 0; index < sleeps.size(); index++) {
                    assertTrue(sleeps.get(index) >= expect.get("minimum_retry_delays_ms").get(index).asLong(), id);
                }
            }
        }

        private void assertJournal(Instant started, Instant finished) throws Exception {
            JsonNode journal = journal();
            assertTrue(journalSchema.validate(journal).isEmpty(), id + ": journal schema");
            JsonNode requests = journal.get("requests");
            assertEquals(expect.get("attempts").asInt(), requests.size(), id);
            Map<String, String> generated = new HashMap<>();
            for (int index = 0; index < requests.size(); index++) {
                JsonNode entry = requests.get(index);
                JsonNode userAgent = entry.path("headers").path("user-agent");
                assertEquals(1, userAgent.size(), id);
                assertTrue(USER_AGENT.matcher(userAgent.get(0).asString()).matches(), id + ": " + userAgent);
                if (!expect.has("request")) {
                    continue;
                }
                JsonNode request = expect.get("request");
                assertEquals(index + 1, entry.get("sequence").asInt(), id);
                assertEquals("POST", entry.get("method").asString(), id);
                assertEquals(request.get("path").asString(), entry.get("path").asString(), id);
                assertEquals(List.of(request.get("authorization").asString()),
                        MAPPER.convertValue(entry.path("headers").path("authorization"), List.class), id);
                ObjectNode actual = (ObjectNode) MAPPER.readTree(entry.get("body").asString());
                for (String field : List.of("event_id", "occurred_at")) {
                    if (request.get("payload").has(field)) {
                        continue;
                    }
                    JsonNode value = actual.remove(field);
                    assertNotNull(value, id + " " + field);
                    String text = value.asString();
                    if ("event_id".equals(field)) {
                        assertTrue(EVENT_ID.matcher(text).matches(), id + " " + text);
                    } else {
                        assertTrue(OCCURRED_AT.matcher(text).matches(), id + " " + text);
                        Instant time = Instant.parse(text);
                        assertFalse(time.isBefore(started.minusSeconds(1)) || time.isAfter(finished.plusSeconds(1)), id + " " + text);
                    }
                    String previous = generated.putIfAbsent(field, text);
                    if (previous != null) {
                        assertEquals(previous, text, id + " reuses " + field);
                    }
                }
                assertEquals(canonical(request.get("payload")), canonical(actual), id + ": payload");
            }
        }

        private static Object canonical(JsonNode node) {
            if (node.isObject()) {
                Map<String, Object> members = new java.util.TreeMap<>();
                for (Iterator<Map.Entry<String, JsonNode>> fields = node.properties().iterator(); fields.hasNext(); ) {
                    Map.Entry<String, JsonNode> field = fields.next();
                    members.put(field.getKey(), canonical(field.getValue()));
                }
                return Map.of("object", members);
            }
            if (node.isArray()) {
                List<Object> items = new ArrayList<>();
                node.forEach(item -> items.add(canonical(item)));
                return Map.of("list", items);
            }
            if (node.isNumber()) {
                return node.decimalValue().stripTrailingZeros();
            }
            return node.isNull() ? "null" : node.asString();
        }

        private JsonNode journal() throws IOException {
            return MAPPER.readTree(control("GET", "/__control/requests", null));
        }

        private String control(String method, String path, String body) throws IOException {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(env.get("cekat.conformance.controlUrl") + path));
            if (body == null) {
                request.method(method, HttpRequest.BodyPublishers.noBody());
            } else {
                request.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body));
            }
            try {
                HttpResponse<String> response = CONTROL.send(request.build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() != 200 && response.statusCode() != 204) {
                    fail(id + ": mock control " + path + " returned " + response.statusCode());
                }
                return response.body();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted while calling mock control", interrupted);
            }
        }
    }
}
