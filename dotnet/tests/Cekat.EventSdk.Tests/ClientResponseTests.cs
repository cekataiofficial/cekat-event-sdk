using System.Net;
using System.Text;

namespace Cekat.EventSdk.Tests;

public sealed class ClientResponseTests
{
    [Theory]
    [InlineData("""{"data":{"success":true,"message":"m","event_key":"k","validated_properties":[]}}""")]
    [InlineData("""{"success":true}""")]
    [InlineData("""{"success":true,"data":[]}""")]
    [InlineData("""{"success":true,"data":{"success":false,"message":"m","event_key":"k","validated_properties":[]}}""")]
    [InlineData("""{"success":true,"data":{"success":"true","message":"m","event_key":"k","validated_properties":[]}}""")]
    [InlineData("""{"success":true,"data":{"success":true,"message":"","event_key":"k","validated_properties":[]}}""")]
    [InlineData("""{"success":true,"data":{"success":true,"message":"m","event_key":null,"validated_properties":[]}}""")]
    [InlineData("""{"success":true,"data":{"success":true,"message":"m","event_key":"k","validated_properties":{}}}""")]
    [InlineData("""{"success":true,"data":{"success":true,"message":"m","event_key":"k","validated_properties":["a",1]}}""")]
    [InlineData("not json")]
    public async Task Nonconforming_success_bodies_are_decode_errors(string body)
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK, body);
        using var client = TestClients.Create(handler);
        var error = await Assert.ThrowsAsync<CekatResponseDecodeException>(() => client.UserLoginAsync(new EventInput(Email: "a")));
        Assert.Equal((1, false, HttpStatusCode.OK, body), (error.Attempts, error.DeliveryOutcomeUnknown, error.StatusCode, error.RawBody));
    }

    [Fact]
    public async Task Unknown_success_fields_are_ignored()
    {
        const string body = """{"success":true,"extra":1,"data":{"success":true,"message":"m","event_key":"k","validated_properties":[],"more":{}}}""";
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK, body);
        using var client = TestClients.Create(handler);
        var acknowledgement = await client.UserLoginAsync(new EventInput(Email: "a"));
        Assert.Equal(body, acknowledgement.RawBody);
    }

    [Fact]
    public async Task Oversized_success_body_is_rejected_and_bounded()
    {
        var stream = new ChunkedStream(new byte[16_384], new byte[16_384], new byte[16_384], new byte[16_384], new byte[10], new byte[5]);
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK, stream);
        using var client = TestClients.Create(handler);
        var error = await Assert.ThrowsAsync<CekatResponseDecodeException>(() => client.UserLoginAsync(new EventInput(Email: "a")));
        Assert.Equal(65_536, error.GetRawBodyBytes().Length);
        Assert.Equal(5, stream.Consumed);
    }

    [Fact]
    public async Task Interrupted_success_body_is_a_decode_error_without_retry()
    {
        var handler = new TestHttpMessageHandler()
            .Respond(HttpStatusCode.OK, new InterruptedStream(Encoding.UTF8.GetBytes("""{"success":tr""")))
            .Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler);
        var error = await Assert.ThrowsAsync<CekatResponseDecodeException>(() => client.UserLoginAsync(new EventInput(Email: "a")));
        Assert.IsType<IOException>(error.InnerException);
        Assert.Equal("""{"success":tr""", error.RawBody);
        Assert.Single(handler.Requests);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, typeof(CekatApiException))]
    [InlineData(HttpStatusCode.Unauthorized, typeof(CekatAuthenticationException))]
    [InlineData(HttpStatusCode.NotFound, typeof(CekatEventDefinitionNotFoundException))]
    [InlineData(HttpStatusCode.Conflict, typeof(CekatApiException))]
    public async Task Structured_errors_are_typed(HttpStatusCode status, Type errorType)
    {
        const string body = """{"success":false,"error":"nope","code":"bad_thing"}""";
        var handler = new TestHttpMessageHandler().Respond(status, body);
        using var client = TestClients.Create(handler);
        var error = await Assert.ThrowsAnyAsync<CekatApiException>(() => client.UserLoginAsync(new EventInput(Email: "a")));
        Assert.IsType(errorType, error);
        Assert.Equal((status, "nope", "bad_thing", body, 1, false), (error.StatusCode, error.Message, error.Code, error.RawBody, error.Attempts, error.DeliveryOutcomeUnknown));
    }

    [Theory]
    [InlineData(418, "not json", null, "I'm a teapot")]
    [InlineData(422, """{"success":false,"error":""}""", null, "Unprocessable Content")]
    [InlineData(413, """{"success":false,"error":"x","code":5}""", null, "Content Too Large")]
    [InlineData(400, """{"success":true,"error":"x"}""", "Custom Reason", "Custom Reason")]
    [InlineData(599, "", null, "HTTP 599")]
    public async Task Error_messages_fall_back_to_reason_phrase_then_status_text(int status, string body, string? reason, string message)
    {
        var handler = new TestHttpMessageHandler().Respond((HttpStatusCode)status, body, response =>
        {
            // HTTP/2 has no reason phrase on the wire; HTTP/1.1 responses carry the server's phrase.
            response.Version = reason is null ? HttpVersion.Version20 : HttpVersion.Version11;
            response.ReasonPhrase = reason;
        });
        using var client = TestClients.Create(handler);
        var error = await Assert.ThrowsAnyAsync<CekatApiException>(() => client.UserLoginAsync(new EventInput(Email: "a")));
        Assert.Equal(message, error.Message);
        Assert.Null(error.Code);
    }

    [Fact]
    public async Task Error_body_is_truncated_to_the_limit()
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.BadRequest, new string('€', 30_000));
        using var client = TestClients.Create(handler);
        var error = await Assert.ThrowsAsync<CekatApiException>(() => client.UserLoginAsync(new EventInput(Email: "a")));
        Assert.Equal(65_536, error.GetRawBodyBytes().Length);
        Assert.Equal("Bad Request", error.Message);
    }
}
