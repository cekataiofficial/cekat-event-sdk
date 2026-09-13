namespace Cekat.EventSdk.Tests;

public sealed class VisitorContextTests
{
    [Fact]
    public async Task AsyncLocal_scopes_are_isolated_and_restored()
    {
        var context = AsyncLocalVisitorContext.Shared;

        async Task<string?> ReadAsync(string id)
        {
            using var scope = AsyncLocalVisitorContext.Push(id);
            await Task.Yield();
            return await Task.Run(() => context.CurrentVisitorId);
        }

        var values = await Task.WhenAll(ReadAsync("visitor-a"), ReadAsync("visitor-b"));
        Assert.Equal(["visitor-a", "visitor-b"], values);
        Assert.Null(context.CurrentVisitorId);
    }

    [Fact]
    public void Scopes_nest_trim_and_restore_after_exceptions()
    {
        var context = AsyncLocalVisitorContext.Shared;
        using (AsyncLocalVisitorContext.Push(" outer "))
        {
            Assert.Equal("outer", context.CurrentVisitorId);
            Assert.Throws<InvalidOperationException>((Action)(() =>
            {
                using var inner = AsyncLocalVisitorContext.Push("inner");
                Assert.Equal("inner", context.CurrentVisitorId);
                throw new InvalidOperationException();
            }));
            Assert.Equal("outer", context.CurrentVisitorId);
            using (AsyncLocalVisitorContext.Push("   "))
            {
                Assert.Null(context.CurrentVisitorId);
            }
        }

        Assert.Null(context.CurrentVisitorId);
    }

    [Fact]
    public void Disposing_a_scope_twice_does_not_clobber_later_state()
    {
        var first = AsyncLocalVisitorContext.Push("first");
        first.Dispose();
        using var second = AsyncLocalVisitorContext.Push("second");
        first.Dispose();
        Assert.Equal("second", AsyncLocalVisitorContext.Shared.CurrentVisitorId);
    }

    [Theory]
    [InlineData(" header ", "cookie", "header")]
    [InlineData("  ", " cookie ", "cookie")]
    [InlineData(null, "cookie", "cookie")]
    [InlineData(null, "  ", null)]
    public void Header_wins_over_cookie(string? header, string? cookie, string? expected)
    {
        Assert.Equal(expected, VisitorIdResolver.FromHeaderAndCookie(header, cookie));
    }

    [Fact]
    public void Multiple_headers_and_raw_cookies_resolve_in_order()
    {
        Assert.Equal("second", VisitorIdResolver.FromHeadersAndCookies([" ", "second"], ["cookie"]));
        Assert.Equal(
            "raw%20value",
            VisitorIdResolver.FromHeadersAndCookies([], VisitorIdResolver.CookieValues("x_cekat_visitor_id=no; _cekat_visitor_id=  ; _cekat_visitor_id=raw%20value")));
        Assert.Empty(VisitorIdResolver.CookieValues("_cekat_visitor_id"));
        Assert.Empty(VisitorIdResolver.CookieValues(null));
    }

    [Fact]
    public void Explicit_visitor_wins_over_context()
    {
        Assert.Equal("explicit", VisitorIdResolver.ForEvent(" explicit ", new FixedVisitorContext("context")));
        Assert.Equal("context", VisitorIdResolver.ForEvent("  ", new FixedVisitorContext(" context ")));
    }

    [Fact]
    public async Task With_visitor_id_scopes_the_action()
    {
        var observed = await CekatClient.WithVisitorIdAsync(" scoped ", _ => Task.FromResult(AsyncLocalVisitorContext.Shared.CurrentVisitorId));
        Assert.Equal("scoped", observed);
        Assert.Null(AsyncLocalVisitorContext.Shared.CurrentVisitorId);
    }
}
