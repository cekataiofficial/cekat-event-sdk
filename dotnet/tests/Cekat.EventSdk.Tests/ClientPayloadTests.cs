using System.Net;

namespace Cekat.EventSdk.Tests;

public sealed class ClientPayloadTests
{
    [Fact]
    public async Task Order_paid_sends_the_fixed_contract()
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler, context: new FixedVisitorContext("context-visitor"), time: new FixedTimeProvider(new DateTimeOffset(2026, 9, 13, 8, 15, 30, 250, TimeSpan.FromHours(7)).AddTicks(9999)));
        var acknowledgement = await client.OrderPaidAsync(
            125.75m,
            "IDR",
            new EventInput(Email: " ada@example.com ", ContactName: " Ada ", Properties: new Dictionary<string, object?> { ["order_id"] = "ord_123" }));

        Assert.Equal(new AcknowledgementShape(true, "accepted", "order_paid", ["order_id"]), new AcknowledgementShape(acknowledgement.Success, acknowledgement.Message, acknowledgement.EventKey, [.. acknowledgement.ValidatedProperties]));
        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https://example.test/api/events/ingest", request.RequestUri!.ToString());
        Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
        Assert.Equal("secret-token", request.Headers.Authorization.Parameter);
        Assert.Equal("application/json", request.Content!.Headers.ContentType!.ToString());
        Assert.Matches(@"^cekat-event-sdk-dotnet/0\.2\.0 dotnet/\d+\.\d+\.\d+", string.Join(" ", request.Headers.GetValues("User-Agent")));

        var body = handler.Body;
        Assert.Equal("order_paid", body.GetProperty("event_key").GetString());
        Assert.True(body.GetProperty("is_common").GetBoolean());
        Assert.Equal(" ada@example.com ", body.GetProperty("email").GetString());
        Assert.Equal(" Ada ", body.GetProperty("contact_name").GetString());
        Assert.Equal("context-visitor", body.GetProperty("visitor_id").GetString());
        Assert.Equal("2026-09-13T01:15:30.250Z", body.GetProperty("occurred_at").GetString());
        Assert.Matches("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", body.GetProperty("event_id").GetString());
        Assert.Equal("""{"order_id":"ord_123","amount":125.75,"currency":"IDR"}""", body.GetProperty("properties").GetRawText());
        Assert.False(body.TryGetProperty("business_id", out _));
        Assert.False(body.TryGetProperty("phone_number", out _));
    }

    [Theory]
    [InlineData("user_registration", true)]
    [InlineData("user_login", true)]
    [InlineData("order_created", true)]
    [InlineData("form_submitted", true)]
    [InlineData("signup_step", false)]
    public async Task Wrappers_send_fixed_keys(string eventKey, bool isCommon)
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler);
        var input = new EventInput(PhoneNumber: "+62");
        await (eventKey switch
        {
            "user_registration" => client.UserRegistrationAsync(input),
            "user_login" => client.UserLoginAsync(input),
            "order_created" => client.OrderCreatedAsync(input),
            "form_submitted" => client.FormSubmittedAsync(input),
            _ => client.CustomEventAsync(eventKey, input),
        });
        Assert.Equal(eventKey, handler.Body.GetProperty("event_key").GetString());
        Assert.Equal(isCommon, handler.Body.GetProperty("is_common").GetBoolean());
    }

    [Fact]
    public async Task Explicit_event_id_and_visitor_win_and_scopes_precede_context()
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK).Respond(HttpStatusCode.OK).Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler, context: new FixedVisitorContext("context"));
        await client.UserLoginAsync(new EventInput(Email: "a", VisitorId: " explicit ", EventId: " evt-1 "));
        Assert.Equal("explicit", handler.Body.GetProperty("visitor_id").GetString());
        Assert.Equal("evt-1", handler.Body.GetProperty("event_id").GetString());

        using (AsyncLocalVisitorContext.Push("scoped"))
        {
            await client.UserLoginAsync(new EventInput(Email: "a", VisitorId: "  "));
        }

        Assert.Equal("scoped", handler.Body.GetProperty("visitor_id").GetString());
        await client.UserLoginAsync(new EventInput(Email: "a"));
        Assert.Equal("context", handler.Body.GetProperty("visitor_id").GetString());
    }

    [Fact]
    public async Task No_visitor_is_omitted()
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler);
        await client.UserLoginAsync(new EventInput(Email: "a"));
        Assert.False(handler.Body.TryGetProperty("visitor_id", out _));
        Assert.False(handler.Body.TryGetProperty("properties", out _));
    }

    [Fact]
    public async Task Injected_http_client_is_not_disposed_and_owned_client_is()
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK);
        var http = new HttpClient(handler);
        using (var client = new CekatClient(TestHttpMessageHandler.Options(), http))
        {
            await client.UserLoginAsync(new EventInput(Email: "a"));
        }

        Assert.False(handler.Disposed);
        http.Dispose();
    }

    private sealed record AcknowledgementShape(bool Success, string Message, string EventKey, string[] Properties)
    {
        public bool Equals(AcknowledgementShape? other) =>
            other is not null && Success == other.Success && Message == other.Message && EventKey == other.EventKey && Properties.SequenceEqual(other.Properties);

        public override int GetHashCode() => HashCode.Combine(Success, Message, EventKey);
    }
}
