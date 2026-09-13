using System.Collections.Immutable;
using System.Dynamic;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cekat.EventSdk.Tests;

public sealed class ValidationTests
{
    [Fact]
    public void Options_use_approved_defaults()
    {
        var options = new CekatClientOptions { AccessToken = "token" };
        Assert.Equal(new Uri("https://server.cekat.ai"), options.BaseUrl);
        Assert.Equal(TimeSpan.FromSeconds(3), options.Timeout);
        Assert.Equal(2, options.RetryCount);
        Assert.Equal("/api/events/ingest", CekatConstants.IngestPath);
        Assert.DoesNotContain("token", options.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Blank_access_token_is_rejected(string? token)
    {
        var error = Assert.Throws<CekatValidationException>(() => new CekatClient(new CekatClientOptions { AccessToken = token }));
        Assert.Equal(0, error.Attempts);
    }

    [Theory]
    [InlineData("http://localhost:43127", "http://localhost:43127/api/events/ingest")]
    [InlineData("https://Example.TEST:8443/", "https://example.test:8443/api/events/ingest")]
    [InlineData("http://[::1]:8080", "http://[::1]:8080/api/events/ingest")]
    public void Base_url_is_normalized_to_an_origin(string baseUrl, string endpoint)
    {
        using var client = new CekatClient(new CekatClientOptions { AccessToken = "t", BaseUrl = new Uri(baseUrl) });
        Assert.Equal($"CekatClient {{ Endpoint = {endpoint} }}", client.ToString());
    }

    [Theory]
    [InlineData("ftp://example.test")]
    [InlineData("https://user:pw@example.test")]
    [InlineData("https://example.test/api")]
    [InlineData("https://example.test/?x=1")]
    [InlineData("https://example.test/#fragment")]
    [InlineData("file:///tmp/x")]
    public void Base_url_rejects_non_origins(string baseUrl)
    {
        Assert.Throws<CekatValidationException>(() => new CekatClient(new CekatClientOptions { AccessToken = "t", BaseUrl = new Uri(baseUrl) }));
    }

    [Fact]
    public void Relative_base_url_timeout_and_retry_count_are_rejected()
    {
        Assert.Throws<CekatValidationException>(() => new CekatClient(new CekatClientOptions { AccessToken = "t", BaseUrl = new Uri("/api", UriKind.Relative) }));
        Assert.Throws<CekatValidationException>(() => new CekatClient(new CekatClientOptions { AccessToken = "t", Timeout = TimeSpan.Zero }));
        Assert.Throws<CekatValidationException>(() => new CekatClient(new CekatClientOptions { AccessToken = "t", Timeout = TimeSpan.FromSeconds(-1) }));
        Assert.Throws<CekatValidationException>(() => new CekatClient(new CekatClientOptions { AccessToken = "t", RetryCount = -1 }));
        Assert.Throws<CekatValidationException>(() => new CekatClient(null!));
    }

    public static TheoryData<string, EventInput> InvalidEvents => new()
    {
        { " ", new EventInput(Email: "a@example.test") },
        { "k", new EventInput(Email: " ", PhoneNumber: "\t") },
        { "k", new EventInput() },
        { "k", new EventInput(Email: "a", Properties: new List<int> { 1 }) },
        { "k", new EventInput(Email: "a", Properties: "text") },
        { "k", new EventInput(Email: "a", Properties: JsonDocument.Parse("[1]").RootElement) },
        { "k", new EventInput(Email: "a\uD800") },
    };

    [Theory]
    [MemberData(nameof(InvalidEvents))]
    public async Task Invalid_events_fault_the_task_before_any_request(string eventKey, EventInput input)
    {
        var handler = new TestHttpMessageHandler();
        using var client = TestClients.Create(handler);
        var call = client.CustomEventAsync(eventKey, input);
        await Assert.ThrowsAsync<CekatValidationException>(() => call);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Null_input_faults_the_task()
    {
        using var client = TestClients.Create(new TestHttpMessageHandler());
        await Assert.ThrowsAsync<CekatValidationException>(() => client.UserLoginAsync(null!));
        await Assert.ThrowsAsync<CekatValidationException>(() => client.CustomEventAsync(null!, new EventInput(Email: "a")));
    }

    public static TheoryData<string> InvalidValueNames() =>
    [
        "nan", "positive_infinity", "float_negative_infinity", "long_high", "long_low", "ulong_high", "double_high", "decimal_high",
        "object", "datetime", "guid", "enum", "char", "int_keys", "cycle", "list_cycle", "anonymous", "element_high",
        "element_huge", "element_nested_low", "node_nan", "lone_surrogate", "surrogate_key",
    ];

    [Theory]
    [MemberData(nameof(InvalidValueNames))]
    public async Task Properties_reject_non_json_values_at_any_depth(string name)
    {
        var handler = new TestHttpMessageHandler();
        using var client = TestClients.Create(handler);
        var properties = new Dictionary<string, object?> { ["nested"] = new List<object?> { new Dictionary<string, object?> { ["value"] = InvalidValue(name) } } };
        var error = await Assert.ThrowsAsync<CekatValidationException>(() => client.CustomEventAsync("k", new EventInput(Email: "a", Properties: properties)));
        Assert.StartsWith("properties.nested[0]", error.Message, StringComparison.Ordinal);
        Assert.Empty(handler.Requests);
    }

    private static object? InvalidValue(string name)
    {
        switch (name)
        {
            case "cycle":
                var cycle = new Dictionary<string, object?>();
                cycle["self"] = cycle;
                return cycle;
            case "list_cycle":
                var list = new List<object?>();
                list.Add(list);
                return new Dictionary<string, object?> { ["list"] = list };
        }

        return name switch
        {
            "nan" => double.NaN,
            "positive_infinity" => double.PositiveInfinity,
            "float_negative_infinity" => float.NegativeInfinity,
            "long_high" => 9_007_199_254_740_992L,
            "long_low" => -9_007_199_254_740_992L,
            "ulong_high" => 9_007_199_254_740_992UL,
            "double_high" => 9_007_199_254_740_992d,
            "decimal_high" => 9_007_199_254_740_992m,
            "object" => new object(),
            "datetime" => DateTime.UtcNow,
            "guid" => Guid.Empty,
            "enum" => DayOfWeek.Monday,
            "char" => 'c',
            "int_keys" => new Dictionary<int, string> { [1] = "one" },
            "anonymous" => new { Anonymous = true },
            "element_high" => JsonDocument.Parse("9007199254740992").RootElement,
            "element_huge" => JsonDocument.Parse("123456789012345678901234567890").RootElement,
            "element_nested_low" => JsonDocument.Parse("""{"deep":[{"n":-9007199254740992}]}""").RootElement,
            "node_nan" => JsonValue.Create(double.NaN),
            "lone_surrogate" => "\uDC00",
            "surrogate_key" => new Dictionary<string, object?> { ["\uD800"] = 1 },
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };
    }

    [Fact]
    public async Task Properties_accept_the_json_value_domain()
    {
        var handler = new TestHttpMessageHandler().Respond(System.Net.HttpStatusCode.OK);
        using var client = TestClients.Create(handler);
        dynamic expando = new ExpandoObject();
        expando.plan = "pro";
        var shared = new Dictionary<string, object?> { ["x"] = 1 };
        var properties = new Dictionary<string, object?>
        {
            ["null"] = null,
            ["flag"] = true,
            ["text"] = "héllo",
            ["max"] = 9_007_199_254_740_991L,
            ["min"] = -9_007_199_254_740_991L,
            ["uint"] = uint.MaxValue,
            ["double"] = 1.5,
            ["tiny"] = 1e-300,
            ["decimal"] = 125.75m,
            ["array"] = new[] { 1, 2 },
            ["shared"] = new[] { shared, shared },
            ["immutable"] = ImmutableDictionary<string, int>.Empty.Add("a", 1),
            ["expando"] = (object)expando,
            ["element"] = JsonDocument.Parse("""{"n":1.25,"big":9007199254740991,"list":[true,null,"s"]}""").RootElement,
            ["node"] = new JsonObject { ["value"] = 3, ["items"] = new JsonArray(1, "two") },
        };
        await client.CustomEventAsync("k", new EventInput(Email: "a", Properties: properties));
        var sent = handler.Body.GetProperty("properties");
        Assert.Equal(JsonValueKind.Null, sent.GetProperty("null").ValueKind);
        Assert.True(sent.GetProperty("flag").GetBoolean());
        Assert.Equal(9_007_199_254_740_991L, sent.GetProperty("max").GetInt64());
        Assert.Equal(125.75m, sent.GetProperty("decimal").GetDecimal());
        Assert.Equal("""[{"x":1},{"x":1}]""", sent.GetProperty("shared").GetRawText());
        Assert.Equal("""{"a":1}""", sent.GetProperty("immutable").GetRawText());
        Assert.Equal("pro", sent.GetProperty("expando").GetProperty("plan").GetString());
        Assert.Equal("""{"n":1.25,"big":9007199254740991,"list":[true,null,"s"]}""", sent.GetProperty("element").GetRawText());
        Assert.Equal("""{"value":3,"items":[1,"two"]}""", sent.GetProperty("node").GetRawText());
    }

    [Fact]
    public async Task Top_level_json_properties_are_accepted()
    {
        var handler = new TestHttpMessageHandler().Respond(System.Net.HttpStatusCode.OK).Respond(System.Net.HttpStatusCode.OK);
        using var client = TestClients.Create(handler);
        await client.CustomEventAsync("k", new EventInput(Email: "a", Properties: JsonDocument.Parse("""{"a":1}""").RootElement));
        Assert.Equal("""{"a":1}""", handler.Body.GetProperty("properties").GetRawText());
        await client.CustomEventAsync("k", new EventInput(Email: "a", Properties: new JsonObject { ["b"] = 2 }));
        Assert.Equal("""{"b":2}""", handler.Body.GetProperty("properties").GetRawText());
    }

    [Fact]
    public async Task Deep_nesting_is_rejected()
    {
        object? value = "leaf";
        for (var i = 0; i < 200; i++)
        {
            value = new Dictionary<string, object?> { ["next"] = value };
        }

        using var client = TestClients.Create(new TestHttpMessageHandler());
        var error = await Assert.ThrowsAsync<CekatValidationException>(() => client.CustomEventAsync("k", new EventInput(Email: "a", Properties: value)));
        Assert.Contains("nested too deeply", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Order_paid_amount_follows_property_rules()
    {
        using var client = TestClients.Create(new TestHttpMessageHandler());
        await Assert.ThrowsAsync<CekatValidationException>(() => client.OrderPaidAsync(9_007_199_254_740_992m, "IDR", new EventInput(Email: "a")));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("  ", null)]
    [InlineData("IDR", "amount")]
    [InlineData("IDR", "currency")]
    public async Task Order_paid_rejects_blank_currency_and_conflicting_properties(string? currency, string? conflict)
    {
        var handler = new TestHttpMessageHandler();
        using var client = TestClients.Create(handler);
        var properties = conflict is null ? null : new Dictionary<string, object?> { [conflict] = 1 };
        await Assert.ThrowsAsync<CekatValidationException>(() => client.OrderPaidAsync(10m, currency!, new EventInput(Email: "a", Properties: properties)));
        Assert.Empty(handler.Requests);
    }
}
