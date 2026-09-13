using Microsoft.AspNetCore.Http;
using Microsoft.Net.Http.Headers;

namespace Cekat.EventSdk.AspNetCore;

/// <summary>
/// Resolves the browser visitor ID (header over cookie, trimmed) and makes it current for the rest of the
/// pipeline: in <see cref="HttpContext.Items"/> and in an <see cref="AsyncLocalVisitorContext"/> scope that
/// also flows into work started by the request. Visitor IDs are untrusted; never use them for authorization.
/// </summary>
public sealed class CekatVisitorMiddleware(RequestDelegate next)
{
    /// <summary>Runs the middleware.</summary>
    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var visitorId = VisitorIdResolver.FromHeadersAndCookies(
            context.Request.Headers[CekatConstants.VisitorHeader],
            context.Request.Headers[HeaderNames.Cookie].SelectMany(VisitorIdResolver.CookieValues)
                .Append(context.Request.Cookies[CekatConstants.VisitorCookie]));

        var hadPrevious = context.Items.TryGetValue(AspNetCoreVisitorContext.ItemKey, out var previous);
        if (visitorId is null)
        {
            context.Items.Remove(AspNetCoreVisitorContext.ItemKey);
        }
        else
        {
            context.Items[AspNetCoreVisitorContext.ItemKey] = visitorId;
        }

        try
        {
            using var scope = AsyncLocalVisitorContext.Push(visitorId);
            await next(context).ConfigureAwait(false);
        }
        finally
        {
            if (hadPrevious)
            {
                context.Items[AspNetCoreVisitorContext.ItemKey] = previous;
            }
            else
            {
                context.Items.Remove(AspNetCoreVisitorContext.ItemKey);
            }
        }
    }
}
