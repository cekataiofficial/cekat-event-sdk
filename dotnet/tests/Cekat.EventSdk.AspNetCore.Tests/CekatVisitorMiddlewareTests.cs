using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using Cekat.EventSdk.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Cekat.EventSdk.AspNetCore.Tests;

public sealed class CekatVisitorMiddlewareTests
{
    private static DefaultHttpContext Context(string? header = null, string? cookie = null)
    {
        var context = new DefaultHttpContext();
        if (header is not null)
        {
            context.Request.Headers[CekatConstants.VisitorHeader] = header;
        }

        if (cookie is not null)
        {
            context.Request.Headers.Cookie = cookie;
        }

        return context;
    }

    [Theory]
    [InlineData(" header ", "_cekat_visitor_id=cookie", "header")]
    [InlineData("   ", "a=1; _cekat_visitor_id= cookie ", "cookie")]
    [InlineData(null, "_cekat_visitor_id=raw%20value", "raw%20value")]
    [InlineData(null, "other=1", null)]
    public async Task Resolves_header_over_cookie_during_the_request_and_cleans_up(string? header, string? cookie, string? expected)
    {
        var context = Context(header, cookie);
        string? item = null;
        string? scoped = null;
        var middleware = new CekatVisitorMiddleware(httpContext =>
        {
            item = AspNetCoreVisitorContext.FromHttpContext(httpContext);
            scoped = AsyncLocalVisitorContext.Shared.CurrentVisitorId;
            return Task.CompletedTask;
        });
        await middleware.InvokeAsync(context);
        Assert.Equal(expected, item);
        Assert.Equal(expected, scoped);
        Assert.False(context.Items.ContainsKey(AspNetCoreVisitorContext.ItemKey));
        Assert.Null(AsyncLocalVisitorContext.Shared.CurrentVisitorId);
        Assert.False(context.Response.Headers.ContainsKey("Set-Cookie"));
    }

    [Fact]
    public async Task Restores_the_previous_item_after_an_exception()
    {
        var context = Context(header: "inner");
        context.Items[AspNetCoreVisitorContext.ItemKey] = "outer";
        var middleware = new CekatVisitorMiddleware(httpContext =>
        {
            Assert.Equal("inner", AspNetCoreVisitorContext.FromHttpContext(httpContext));
            throw new InvalidOperationException("boom");
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() => middleware.InvokeAsync(context));
        Assert.Equal("outer", context.Items[AspNetCoreVisitorContext.ItemKey]);
    }

    [Fact]
    public async Task Concurrent_requests_are_isolated()
    {
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var observed = new ConcurrentDictionary<string, string?>();
        var middleware = new CekatVisitorMiddleware(async httpContext =>
        {
            await gate.Task;
            observed[httpContext.TraceIdentifier] = AsyncLocalVisitorContext.Shared.CurrentVisitorId;
        });
        var first = Context(header: "a");
        first.TraceIdentifier = "first";
        var second = Context(cookie: "_cekat_visitor_id=b");
        second.TraceIdentifier = "second";
        var running = Task.WhenAll(middleware.InvokeAsync(first), middleware.InvokeAsync(second));
        gate.SetResult();
        await running;
        Assert.Equal("a", observed["first"]);
        Assert.Equal("b", observed["second"]);
    }

    [Fact]
    public void Visitor_context_reads_request_items()
    {
        var accessor = new HttpContextAccessor { HttpContext = Context() };
        var visitorContext = new AspNetCoreVisitorContext(accessor);
        Assert.Null(visitorContext.CurrentVisitorId);
        accessor.HttpContext.Items[AspNetCoreVisitorContext.ItemKey] = "item";
        Assert.Equal("item", visitorContext.CurrentVisitorId);
        accessor.HttpContext = null;
        Assert.Null(visitorContext.CurrentVisitorId);
    }

    [Fact]
    public void Registration_validates_options_at_startup()
    {
        var services = new ServiceCollection();
        Assert.Throws<CekatValidationException>(() => services.AddCekatEventSdk(options => options.AccessToken = " "));
        Assert.Throws<CekatValidationException>(() => services.AddCekatEventSdk(options =>
        {
            options.AccessToken = "token";
            options.BaseUrl = new Uri("https://example.test/path");
        }));
    }

    [Fact]
    public async Task Pipeline_tracks_events_with_the_request_visitor_including_background_work()
    {
        await using var ingest = await FakeIngest.StartAsync();
        using var host = await new HostBuilder()
            .ConfigureWebHost(web => web
                .UseTestServer()
                .ConfigureServices(services =>
                {
                    services.AddRouting();
                    services.AddCekatEventSdk(options =>
                    {
                        options.AccessToken = "secret-token";
                        options.BaseUrl = ingest.Origin;
                    });
                })
                .Configure(app =>
                {
                    app.UseCekatVisitor();
                    app.UseRouting();
                    app.UseEndpoints(endpoints =>
                    {
                        endpoints.MapPost("/checkout", async (Order order, CekatClient cekat) =>
                        {
                            var acknowledgement = await cekat.OrderPaidAsync(order.Amount, order.Currency, new EventInput(Email: order.Email));
                            _ = Task.Run(async () =>
                            {
                                await Task.Delay(50);
                                await cekat.UserLoginAsync(new EventInput(Email: order.Email));
                            });
                            return Results.Ok(new { acknowledgement.EventKey });
                        });
                    });
                }))
            .StartAsync();

        using var client = host.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/checkout") { Content = JsonContent.Create(new Order(99.5m, "IDR", "buyer@example.test")) };
        request.Headers.Add(CekatConstants.VisitorHeader, " visitor-1 ");
        request.Headers.Add("Cookie", "_cekat_visitor_id=cookie");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        Assert.Contains("order_paid", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        var bodies = await ingest.WaitForAsync(2);
        Assert.All(bodies, body => Assert.Equal("visitor-1", body.GetProperty("visitor_id").GetString()));
        Assert.Equal(["order_paid", "user_login"], bodies.Select(body => body.GetProperty("event_key").GetString()!));
        Assert.Equal("""{"amount":99.5,"currency":"IDR"}""", bodies[0].GetProperty("properties").GetRawText());
        await host.StopAsync();
    }

    private sealed record Order(decimal Amount, string Currency, string Email);

    /// <summary>A real Kestrel server standing in for the Cekat ingest API.</summary>
    private sealed class FakeIngest : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly ConcurrentQueue<JsonElement> _bodies = new();

        private FakeIngest(WebApplication app) => _app = app;

        public Uri Origin => new(_app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First());

        public static async Task<FakeIngest> StartAsync()
        {
            var builder = WebApplication.CreateSlimBuilder();
            builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
            var app = builder.Build();
            var ingest = new FakeIngest(app);
            app.MapPost(CekatConstants.IngestPath, async (HttpRequest request) =>
            {
                Assert.Equal("Bearer secret-token", request.Headers.Authorization.ToString());
                using var document = await JsonDocument.ParseAsync(request.Body);
                ingest._bodies.Enqueue(document.RootElement.Clone());
                var key = document.RootElement.GetProperty("event_key").GetString();
                return Results.Text($$$"""{"success":true,"data":{"success":true,"message":"accepted","event_key":"{{{key}}}","validated_properties":[]}}""", "application/json");
            });
            await app.StartAsync();
            return ingest;
        }

        public async Task<JsonElement[]> WaitForAsync(int count)
        {
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (_bodies.Count < count && DateTime.UtcNow < deadline)
            {
                await Task.Delay(10);
            }

            return [.. _bodies];
        }

        public async ValueTask DisposeAsync() => await _app.DisposeAsync();
    }
}
