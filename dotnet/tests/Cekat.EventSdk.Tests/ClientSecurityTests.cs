using System.Net;

namespace Cekat.EventSdk.Tests;

public sealed class ClientSecurityTests
{
    [Fact]
    public async Task Token_never_appears_in_errors_or_diagnostics()
    {
        var options = TestHttpMessageHandler.Options();
        var handler = new TestHttpMessageHandler()
            .Respond(HttpStatusCode.Unauthorized, """{"success":false,"error":"bad token"}""")
            .Throw(new HttpRequestException("boom"));
        using var client = TestClients.Create(handler, options: TestHttpMessageHandler.Options(retryCount: 0));
        var errors = new List<Exception>
        {
            await Assert.ThrowsAsync<CekatAuthenticationException>(() => client.UserLoginAsync(new EventInput(Email: "a"))),
            await Assert.ThrowsAsync<CekatTransportException>(() => client.UserLoginAsync(new EventInput(Email: "a"))),
            await Assert.ThrowsAsync<CekatValidationException>(() => client.UserLoginAsync(new EventInput())),
        };
        foreach (var text in errors.Select(error => error.ToString()).Append(client.ToString()).Append(options.ToString()))
        {
            Assert.DoesNotContain("secret-token", text, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Authorization_is_set_per_request_without_mutating_shared_headers()
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.OK);
        var http = new HttpClient(handler);
        using var client = new CekatClient(TestHttpMessageHandler.Options(), http);
        await client.UserLoginAsync(new EventInput(Email: "a"));
        Assert.Null(http.DefaultRequestHeaders.Authorization);
        Assert.Equal("secret-token", handler.Requests[0].Headers.Authorization!.Parameter);
        http.Dispose();
    }
}
