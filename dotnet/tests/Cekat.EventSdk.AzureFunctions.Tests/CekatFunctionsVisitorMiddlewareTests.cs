using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Cekat.EventSdk.AzureFunctions.Tests;

public sealed class CekatFunctionsVisitorMiddlewareTests
{
    private static CekatFunctionsVisitorMiddleware Middleware(Func<FunctionContext, HttpRequestData?> request) =>
        new(context => ValueTask.FromResult(request(context)));

    private static TestHttpRequestData Request(FunctionContext context, string? header = null, string? cookieHeader = null, params HttpCookie[] cookies)
    {
        var headers = new HttpHeadersCollection();
        if (header is not null)
        {
            headers.Add(CekatConstants.VisitorHeader, header);
        }

        if (cookieHeader is not null)
        {
            headers.Add("Cookie", cookieHeader);
        }

        return new TestHttpRequestData(context, headers, cookies);
    }

    [Theory]
    [InlineData(" header ", "_cekat_visitor_id=cookie", "header")]
    [InlineData("  ", "a=1; _cekat_visitor_id= cookie ", "cookie")]
    [InlineData(null, null, null)]
    public async Task Http_invocations_resolve_header_over_cookie(string? header, string? cookieHeader, string? expected)
    {
        var context = new TestFunctionContext();
        string? item = null;
        string? scoped = null;
        await Middleware(c => Request(c, header, cookieHeader)).Invoke(context, invoked =>
        {
            item = invoked.GetCekatVisitorId();
            scoped = AsyncLocalVisitorContext.Shared.CurrentVisitorId;
            return Task.CompletedTask;
        });
        Assert.Equal(expected, item);
        Assert.Equal(expected, scoped);
        Assert.Empty(context.Items);
        Assert.Null(AsyncLocalVisitorContext.Shared.CurrentVisitorId);
    }

    [Fact]
    public async Task Parsed_cookies_are_used_when_no_raw_cookie_header_exists()
    {
        var context = new TestFunctionContext();
        string? observed = null;
        await Middleware(c => Request(c, cookies: new HttpCookie(CekatConstants.VisitorCookie, " parsed "))).Invoke(context, invoked =>
        {
            observed = invoked.GetCekatVisitorId();
            return Task.CompletedTask;
        });
        Assert.Equal("parsed", observed);
    }

    [Fact]
    public async Task Non_http_triggers_run_without_a_visitor()
    {
        var context = new TestFunctionContext();
        var invoked = false;
        await Middleware(_ => null).Invoke(context, c =>
        {
            invoked = true;
            Assert.Null(c.GetCekatVisitorId());
            return Task.CompletedTask;
        });
        Assert.True(invoked);
    }

    [Fact]
    public async Task Previous_item_is_restored_after_an_exception()
    {
        var context = new TestFunctionContext();
        context.Items[CekatFunctionsVisitorMiddleware.ItemKey] = "outer";
        await Assert.ThrowsAsync<InvalidOperationException>(() => Middleware(c => Request(c, "inner")).Invoke(context, c =>
        {
            Assert.Equal("inner", c.GetCekatVisitorId());
            throw new InvalidOperationException("boom");
        }));
        Assert.Equal("outer", context.Items[CekatFunctionsVisitorMiddleware.ItemKey]);
    }

    [Fact]
    public async Task Concurrent_invocations_are_isolated()
    {
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var middleware = Middleware(c => Request(c, header: c.FunctionId == "function" ? (string)c.Items["expected"] : null));
        async Task<string?> RunAsync(string visitor)
        {
            var context = new TestFunctionContext();
            context.Items["expected"] = visitor;
            string? observed = null;
            await middleware.Invoke(context, async _ =>
            {
                await gate.Task;
                observed = AsyncLocalVisitorContext.Shared.CurrentVisitorId;
            });
            return observed;
        }

        var running = Task.WhenAll(RunAsync("a"), RunAsync("b"));
        gate.SetResult();
        Assert.Equal(["a", "b"], await running);
    }

    [Fact]
    public void Registration_validates_options_and_registers_a_singleton_client()
    {
        var services = new ServiceCollection();
        Assert.Throws<CekatValidationException>(() => services.AddCekatEventSdk(options => options.AccessToken = null));
        services.AddCekatEventSdk(options => options.AccessToken = "token");
        using var provider = services.BuildServiceProvider();
        Assert.Same(provider.GetRequiredService<CekatClient>(), provider.GetRequiredService<CekatClient>());
    }
}
