using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Json.Schema;

namespace Cekat.EventSdk.Conformance.Tests;

/// <summary>
/// Executes every shared fixture against the mock ingest server, driven only by the four
/// CEKAT_CONFORMANCE_* variables that scripts/conformance validates.
/// </summary>
public sealed partial class ConformanceTests
{
    private static readonly string[] RequiredEnvironment =
    [
        "CEKAT_CONFORMANCE_BASE_URL",
        "CEKAT_CONFORMANCE_CONTROL_URL",
        "CEKAT_CONFORMANCE_ACCESS_TOKEN",
        "CEKAT_CONFORMANCE_FIXTURES",
    ];

    private static readonly Dictionary<string, Type> ErrorTypes = new()
    {
        ["validation_error"] = typeof(CekatValidationException),
        ["authentication_error"] = typeof(CekatAuthenticationException),
        ["event_definition_not_found_error"] = typeof(CekatEventDefinitionNotFoundException),
        ["api_error"] = typeof(CekatApiException),
        ["transport_error"] = typeof(CekatTransportException),
        ["response_decode_error"] = typeof(CekatResponseDecodeException),
    };

    [Fact]
    public void Schemas_reject_malformed_fixtures()
    {
        var directory = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../conformance/fixtures"));
        var schemas = Schemas.Load(Path.Combine(directory, "schemas"));
        var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "cases", "retry-500-500-success.json")))!;
        Assert.True(schemas.IsValidCase(fixture));
        Action<JsonNode>[] mutations =
        [
            value => value["responses"]![0]!["headers"] = 1,
            value => value["expect"]!["status"] = "400",
            value => value["expect"]!["request"]!["extra"] = true,
            value => value["operation"]!.AsObject().Remove("currency"),
            value => value["expect"]!["jitter_bounds_ms"] = new JsonArray(new JsonArray(0, 101), new JsonArray(0, 200)),
        ];
        foreach (var mutate in mutations)
        {
            var invalid = fixture.DeepClone();
            mutate(invalid);
            Assert.False(schemas.IsValidCase(invalid));
        }
    }

    [Fact]
    public async Task Every_discovered_fixture_executes_exactly_once()
    {
        var environment = RequiredEnvironment.ToDictionary(name => name, name => Environment.GetEnvironmentVariable(name) ?? string.Empty);
        var missing = environment.Where(pair => pair.Value.Length == 0).Select(pair => pair.Key).ToArray();
        Assert.True(missing.Length == 0, $"missing {string.Join(", ", missing)}; run scripts/conformance");
        var extra = Environment.GetEnvironmentVariables().Keys.Cast<string>()
            .Where(name => name.StartsWith("CEKAT_CONFORMANCE_", StringComparison.Ordinal) && !RequiredEnvironment.Contains(name))
            .ToArray();
        Assert.True(extra.Length == 0, $"unrecognized conformance environment variables: {string.Join(", ", extra)}");

        var directory = environment["CEKAT_CONFORMANCE_FIXTURES"];
        Assert.True(Path.IsPathFullyQualified(directory) && Directory.Exists(directory), "CEKAT_CONFORMANCE_FIXTURES must be an absolute directory");
        var schemas = Schemas.Load(Path.Combine(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(directory))!, "schemas"));

        var files = Directory.GetFiles(directory, "*.json", SearchOption.TopDirectoryOnly).Order(StringComparer.Ordinal).ToArray();
        Assert.True(files.Length > 0, "fixture corpus contains no direct JSON files");

        var discovered = new List<string>();
        var passed = new List<string>();
        using var control = new MockControl(new Uri(environment["CEKAT_CONFORMANCE_CONTROL_URL"]));
        foreach (var file in files)
        {
            var node = JsonNode.Parse(File.ReadAllText(file))!;
            var errors = schemas.CaseErrors(node);
            Assert.True(errors.Count == 0, $"{Path.GetFileName(file)} violates the shared schema: {string.Join("; ", errors.Take(3))}");
            using var document = JsonDocument.Parse(node.ToJsonString());
            var fixture = document.RootElement;
            var id = fixture.GetProperty("id").GetString()!;
            Assert.True(id == Path.GetFileNameWithoutExtension(file), $"{Path.GetFileName(file)}: filename/ID mismatch");
            Assert.False(discovered.Contains(id), $"duplicate fixture ID {id}");
            discovered.Add(id);
            if (fixture.TryGetProperty("applicability", out var applicability)
                && applicability.GetProperty("inapplicable_languages").EnumerateArray().Any(language => language.GetString() == "dotnet"))
            {
                Assert.Fail($"{id}: .NET supports caller cancellation, so no fixture may declare it inapplicable");
            }

            await new Case(fixture, environment, schemas, control).ExecuteAsync();
            passed.Add(id);
            Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, string> { ["id"] = id, ["status"] = "passed" }));
        }

        Assert.Equal(discovered.Order(StringComparer.Ordinal), passed.Order(StringComparer.Ordinal));
    }

    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")]
    private static partial Regex EventIdPattern();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")]
    private static partial Regex OccurredAtPattern();

    [GeneratedRegex(@"^cekat-event-sdk-dotnet/\d+\.\d+\.\d+\S*( .+)?$")]
    private static partial Regex UserAgentPattern();

    private sealed class Schemas
    {
        private readonly JsonSchema _case;
        private readonly JsonSchema _journal;

        private Schemas(JsonSchema @case, JsonSchema journal)
        {
            _case = @case;
            _journal = journal;
        }

        public static Schemas Load(string directory)
        {
            var options = new BuildOptions { SchemaRegistry = new SchemaRegistry() };
            string[] order = ["json-value", "event-payload", "success-envelope", "error-envelope", "mock-response-queue", "request-journal", "conformance-case"];
            var built = order.ToDictionary(name => name, name => JsonSchema.FromFile(Path.Combine(directory, $"{name}.schema.json"), options));
            return new Schemas(built["conformance-case"], built["request-journal"]);
        }

        public bool IsValidCase(JsonNode fixture) => CaseErrors(fixture).Count == 0;

        public List<string> CaseErrors(JsonNode fixture) => Errors(_case, fixture);

        public List<string> JournalErrors(JsonNode journal) => Errors(_journal, journal);

        private static List<string> Errors(JsonSchema schema, JsonNode value)
        {
            using var document = JsonDocument.Parse(value.ToJsonString());
            var result = schema.Evaluate(document.RootElement, new EvaluationOptions { OutputFormat = OutputFormat.List });
            return result.IsValid
                ? []
                : (result.Details ?? []).Where(detail => detail.Errors is { Count: > 0 })
                    .SelectMany(detail => detail.Errors!.Select(error => $"{detail.InstanceLocation}: {error.Value}"))
                    .DefaultIfEmpty("invalid").ToList();
        }
    }

    private sealed class Case(JsonElement fixture, Dictionary<string, string> environment, Schemas schemas, MockControl control)
    {
        private readonly string _id = fixture.GetProperty("id").GetString()!;
        private readonly JsonElement _expect = fixture.GetProperty("expect");
        private readonly List<double> _sleeps = [];
        private string? _expanded;

        public async Task ExecuteAsync()
        {
            await control.ResetAsync();
            var responses = fixture.TryGetProperty("responses", out var queued) ? JsonNode.Parse(queued.GetRawText())!.AsArray() : [];
            if (fixture.TryGetProperty("response_body_recipe", out var recipe))
            {
                Assert.Single(responses);
                _expanded = Recipes.ExpandBody(recipe);
                responses[0]!["body"] = _expanded;
            }

            await control.QueueAsync(responses);

            var started = DateTimeOffset.UtcNow;
            if (fixture.TryGetProperty("cancellation", out var cancellation))
            {
                Assert.Equal("caller_cancelled", _expect.GetProperty("result").GetString());
                await RunCancellationAsync(cancellation.GetProperty("phase").GetString()!);
            }
            else
            {
                var (acknowledgement, error) = await RunAsync(delay: null, CancellationToken.None);
                AssertResult(acknowledgement, error);
            }

            var finished = DateTimeOffset.UtcNow;
            AssertDelays();
            await AssertJournalAsync(started, finished);
        }

        private CekatClient Client(Func<TimeSpan, CancellationToken, Task>? delay)
        {
            var options = fixture.TryGetProperty("client", out var client) ? client : default;
            return new CekatClient(
                new CekatClientOptions
                {
                    AccessToken = environment["CEKAT_CONFORMANCE_ACCESS_TOKEN"],
                    BaseUrl = new Uri(environment["CEKAT_CONFORMANCE_BASE_URL"]),
                    Timeout = options.ValueKind == JsonValueKind.Object && options.TryGetProperty("timeout_ms", out var timeout)
                        ? TimeSpan.FromMilliseconds(timeout.GetInt32())
                        : TimeSpan.FromSeconds(3),
                    RetryCount = options.ValueKind == JsonValueKind.Object && options.TryGetProperty("retry_count", out var retries) ? retries.GetInt32() : 2,
                },
                httpClient: null,
                visitorContext: null,
                jitter: upperBound => upperBound / 2,
                delay: delay ?? ((duration, _) =>
                {
                    _sleeps.Add(duration.TotalMilliseconds);
                    return Task.CompletedTask;
                }),
                time: null);
        }

        private async Task<(Acknowledgement? Acknowledgement, CekatException? Error)> RunAsync(Func<TimeSpan, CancellationToken, Task>? delay, CancellationToken cancellationToken)
        {
            using var client = Client(delay);
            using var scope = OpenInbound();
            try
            {
                return (await Dispatch(client, cancellationToken), null);
            }
            catch (CekatException error)
            {
                return (null, error);
            }
        }

        private async Task RunCancellationAsync(string phase)
        {
            using var cancellation = new CancellationTokenSource();
            var sleeping = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            Func<TimeSpan, CancellationToken, Task> delay = async (duration, token) =>
            {
                _sleeps.Add(duration.TotalMilliseconds);
                sleeping.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
            };
            if (phase == "before_request")
            {
                await cancellation.CancelAsync();
            }

            var run = RunAsync(delay, cancellation.Token);
            if (phase == "during_request")
            {
                var deadline = DateTime.UtcNow.AddSeconds(2);
                while ((await control.JournalAsync()).GetProperty("requests").GetArrayLength() == 0 && DateTime.UtcNow < deadline)
                {
                    await Task.Delay(2);
                }

                await cancellation.CancelAsync();
            }
            else if (phase == "during_backoff")
            {
                await sleeping.Task.WaitAsync(TimeSpan.FromSeconds(5));
                await cancellation.CancelAsync();
            }
            else
            {
                Assert.Equal("before_request", phase);
            }

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
        }

        private IDisposable OpenInbound()
        {
            if (!fixture.TryGetProperty("inbound", out var inbound))
            {
                return AsyncLocalVisitorContext.Push(null);
            }

            if (inbound.TryGetProperty("header_visitor_id", out _) || inbound.TryGetProperty("cookie_visitor_id", out _))
            {
                var headers = inbound.TryGetProperty("header_visitor_id", out var header) ? [header.GetString()] : Array.Empty<string?>();
                var cookieHeader = inbound.TryGetProperty("cookie_visitor_id", out var cookie) ? $"{CekatConstants.VisitorCookie}={cookie.GetString()}" : null;
                return AsyncLocalVisitorContext.Push(VisitorIdResolver.FromHeadersAndCookies(headers, VisitorIdResolver.CookieValues(cookieHeader)));
            }

            return AsyncLocalVisitorContext.Push(inbound.TryGetProperty("ambient_visitor_id", out var ambient) ? ambient.GetString() : null);
        }

        private Task<Acknowledgement> Dispatch(CekatClient client, CancellationToken cancellationToken)
        {
            var operation = fixture.GetProperty("operation");
            var source = operation.GetProperty("event");
            var properties = operation.TryGetProperty("properties_recipe", out var recipe)
                ? Recipes.Properties(recipe.GetString()!)
                : source.TryGetProperty("properties", out var literal) ? Recipes.ToClr(literal) : null;
            var input = new EventInput(
                Email: Text(source, "email"),
                PhoneNumber: Text(source, "phone_number"),
                ContactName: Text(source, "contact_name"),
                Properties: properties,
                VisitorId: Text(source, "visitor_id"),
                EventId: Text(source, "event_id"),
                OccurredAt: Text(source, "occurred_at") is { } occurredAt ? DateTimeOffset.Parse(occurredAt, CultureInfo.InvariantCulture) : null);
            return operation.GetProperty("name").GetString() switch
            {
                "user_registration" => client.UserRegistrationAsync(input, cancellationToken),
                "user_login" => client.UserLoginAsync(input, cancellationToken),
                "order_created" => client.OrderCreatedAsync(input, cancellationToken),
                "order_paid" => client.OrderPaidAsync(operation.GetProperty("amount").GetDecimal(), operation.GetProperty("currency").GetString()!, input, cancellationToken),
                "custom_event" => client.CustomEventAsync(operation.GetProperty("event_key").GetString()!, input, cancellationToken),
                var name => throw new InvalidOperationException($"{_id}: unknown operation {name}"),
            };
        }

        private static string? Text(JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) ? value.GetString() : null;

        private void AssertResult(Acknowledgement? acknowledgement, CekatException? error)
        {
            var token = environment["CEKAT_CONFORMANCE_ACCESS_TOKEN"];
            if (error is not null)
            {
                Assert.DoesNotContain(token, error.ToString(), StringComparison.Ordinal);
            }

            var result = _expect.GetProperty("result").GetString()!;
            if (result == "acknowledgement")
            {
                Assert.True(error is null, $"{_id}: {error?.GetType().Name} {error?.Message}");
                Assert.NotNull(acknowledgement);
                if (_expect.TryGetProperty("acknowledgement", out var expected))
                {
                    Assert.Equal(expected.GetProperty("success").GetBoolean(), acknowledgement.Success);
                    Assert.Equal(expected.GetProperty("message").GetString(), acknowledgement.Message);
                    Assert.Equal(expected.GetProperty("event_key").GetString(), acknowledgement.EventKey);
                    Assert.Equal(expected.GetProperty("validated_properties").EnumerateArray().Select(item => item.GetString()!), acknowledgement.ValidatedProperties);
                }

                return;
            }

            Assert.True(error is not null && error.GetType() == ErrorTypes[result], $"{_id}: expected {ErrorTypes[result].Name}, got {error?.GetType().Name} {error?.Message}");
            Assert.NotNull(error);
            if (error is not CekatValidationException)
            {
                Assert.True(_expect.GetProperty("attempts").GetInt32() == error.Attempts, $"{_id}: attempts {error.Attempts}");
                var unknown = _expect.TryGetProperty("delivery_outcome_unknown", out var outcome) ? outcome.GetBoolean() : error is CekatTransportException;
                Assert.True(unknown == error.DeliveryOutcomeUnknown, $"{_id}: delivery outcome");
            }

            if (_expect.TryGetProperty("status", out var status))
            {
                var actual = error switch
                {
                    CekatApiException api => (int)api.StatusCode,
                    CekatResponseDecodeException decode => (int)decode.StatusCode,
                    _ => 0,
                };
                Assert.True(status.GetInt32() == actual, $"{_id}: status {actual}");
            }

            foreach (var field in new[] { "error_message", "server_error" })
            {
                if (_expect.TryGetProperty(field, out var message))
                {
                    Assert.True(message.GetString() == error.Message, $"{_id}: message {error.Message}");
                }
            }

            if (_expect.TryGetProperty("server_code", out var code))
            {
                Assert.Equal(code.GetString(), (error as CekatApiException)?.Code);
            }

            if (_expect.TryGetProperty("retained_body_bytes", out var retained))
            {
                var bytes = error switch
                {
                    CekatApiException api => api.GetRawBodyBytes(),
                    CekatResponseDecodeException decode => decode.GetRawBodyBytes(),
                    _ => [],
                };
                Assert.True(retained.GetInt32() == bytes.Length, $"{_id}: retained {bytes.Length}");
                if (_expanded is not null)
                {
                    Assert.Equal(Encoding.UTF8.GetBytes(_expanded).AsSpan(0, bytes.Length).ToArray(), bytes);
                }
            }
        }

        private void AssertDelays()
        {
            var sleeps = _sleeps.Select(value => (int)Math.Round(value)).ToArray();
            if (_expect.TryGetProperty("jitter_bounds_ms", out var bounds))
            {
                Assert.True(bounds.GetArrayLength() == sleeps.Length, $"{_id}: sleeps [{string.Join(", ", sleeps)}]");
                foreach (var (bound, delay) in bounds.EnumerateArray().Zip(sleeps))
                {
                    Assert.InRange(delay, bound[0].GetInt32(), bound[1].GetInt32());
                }
            }

            if (_expect.TryGetProperty("minimum_retry_delays_ms", out var minimums))
            {
                Assert.True(minimums.GetArrayLength() == sleeps.Length, $"{_id}: sleeps [{string.Join(", ", sleeps)}]");
                foreach (var (minimum, delay) in minimums.EnumerateArray().Zip(sleeps))
                {
                    Assert.True(delay >= minimum.GetInt32(), $"{_id}: delay {delay} below {minimum}");
                }
            }
        }

        private async Task AssertJournalAsync(DateTimeOffset started, DateTimeOffset finished)
        {
            var journal = await control.JournalAsync();
            var journalErrors = schemas.JournalErrors(JsonNode.Parse(journal.GetRawText())!);
            Assert.True(journalErrors.Count == 0, $"{_id}: journal schema {string.Join("; ", journalErrors)}");
            var requests = journal.GetProperty("requests").EnumerateArray().ToArray();
            Assert.True(_expect.GetProperty("attempts").GetInt32() == requests.Length, $"{_id}: {requests.Length} requests");
            var hasRequest = _expect.TryGetProperty("request", out var expected);
            var generated = new Dictionary<string, string>();
            for (var index = 0; index < requests.Length; index++)
            {
                var entry = requests[index];
                var agents = entry.GetProperty("headers").TryGetProperty("user-agent", out var agent) ? agent.EnumerateArray().Select(item => item.GetString()!).ToArray() : [];
                Assert.True(agents.Length == 1 && UserAgentPattern().IsMatch(agents[0]), $"{_id}: user-agent [{string.Join(", ", agents)}]");
                if (!hasRequest)
                {
                    continue;
                }

                Assert.Equal(index + 1, entry.GetProperty("sequence").GetInt32());
                Assert.Equal("POST", entry.GetProperty("method").GetString());
                Assert.Equal(expected.GetProperty("path").GetString(), entry.GetProperty("path").GetString());
                Assert.Equal([expected.GetProperty("authorization").GetString()!], entry.GetProperty("headers").GetProperty("authorization").EnumerateArray().Select(item => item.GetString()!));
                var actual = JsonNode.Parse(entry.GetProperty("body").GetString()!)!.AsObject();
                var payload = expected.GetProperty("payload");
                foreach (var field in new[] { "event_id", "occurred_at" })
                {
                    if (payload.TryGetProperty(field, out _))
                    {
                        continue;
                    }

                    var value = actual[field]?.GetValue<string>();
                    actual.Remove(field);
                    Assert.True(value is not null, $"{_id}: {field} missing");
                    if (field == "event_id")
                    {
                        Assert.Matches(EventIdPattern(), value);
                    }
                    else
                    {
                        Assert.Matches(OccurredAtPattern(), value);
                        var moment = DateTimeOffset.Parse(value, CultureInfo.InvariantCulture);
                        Assert.InRange(moment, started.AddSeconds(-1), finished.AddSeconds(1));
                    }

                    Assert.True(generated.TryAdd(field, value) || generated[field] == value, $"{_id}: {field} not reused");
                }

                Assert.True(
                    JsonNode.DeepEquals(Canonical(actual), Canonical(JsonNode.Parse(payload.GetRawText()))),
                    $"{_id}: payload {actual.ToJsonString()}");
            }
        }

        /// <summary>Normalizes numbers so 125.75, 1.2575e2, and 10 vs 10.0 compare by value.</summary>
        private static JsonNode? Canonical(JsonNode? node) => node switch
        {
            JsonObject obj => new JsonObject(obj.Select(pair => KeyValuePair.Create(pair.Key, Canonical(pair.Value)))),
            JsonArray array => new JsonArray(array.Select(Canonical).ToArray()),
            JsonValue value when value.GetValueKind() == JsonValueKind.Number => JsonValue.Create(decimal.Parse(value.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture).ToString("G29", CultureInfo.InvariantCulture)),
            _ => node?.DeepClone(),
        };
    }
}
