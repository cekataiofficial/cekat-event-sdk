using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cekat.EventSdk.Conformance.Tests;

/// <summary>Talks to the mock server's control API using only CEKAT_CONFORMANCE_CONTROL_URL.</summary>
internal sealed class MockControl(Uri controlUrl) : IDisposable
{
    private readonly HttpClient _http = new() { BaseAddress = controlUrl, Timeout = TimeSpan.FromSeconds(10) };

    public async Task ResetAsync()
    {
        using var response = await _http.PostAsync(new Uri("/__control/reset", UriKind.Relative), new ByteArrayContent([]));
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    public async Task QueueAsync(JsonArray responses)
    {
        var body = new JsonObject { ["responses"] = responses };
        using var content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(new Uri("/__control/responses", UriKind.Relative), content);
        Assert.True(response.StatusCode == HttpStatusCode.NoContent, await response.Content.ReadAsStringAsync());
    }

    public async Task<JsonElement> JournalAsync()
    {
        using var response = await _http.GetAsync(new Uri("/__control/requests", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync());
        return document.RootElement.Clone();
    }

    public void Dispose() => _http.Dispose();
}
