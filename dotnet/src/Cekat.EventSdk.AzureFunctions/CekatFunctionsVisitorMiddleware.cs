using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Azure.Functions.Worker.Middleware;

namespace Cekat.EventSdk.AzureFunctions;

/// <summary>
/// Resolves the visitor ID of HTTP-triggered invocations (header over cookie, trimmed) and makes it current
/// for the function: in <see cref="FunctionContext.Items"/> and in an <see cref="AsyncLocalVisitorContext"/>
/// scope. Other triggers run unchanged. Visitor IDs are untrusted; never use them for authorization.
/// </summary>
public sealed class CekatFunctionsVisitorMiddleware : IFunctionsWorkerMiddleware
{
    /// <summary>The <see cref="FunctionContext.Items"/> key holding the invocation's trimmed visitor ID.</summary>
    public const string ItemKey = "Cekat.EventSdk.VisitorId";

    private readonly Func<FunctionContext, ValueTask<HttpRequestData?>> _request;

    /// <summary>Creates the middleware.</summary>
    public CekatFunctionsVisitorMiddleware()
        : this(context => context.GetHttpRequestDataAsync())
    {
    }

    internal CekatFunctionsVisitorMiddleware(Func<FunctionContext, ValueTask<HttpRequestData?>> request)
    {
        _request = request;
    }

    /// <inheritdoc />
    public async Task Invoke(FunctionContext context, FunctionExecutionDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);
        var request = await _request(context).ConfigureAwait(false);
        var visitorId = request is null ? null : Resolve(request);

        var hadPrevious = context.Items.TryGetValue(ItemKey, out var previous);
        if (visitorId is null)
        {
            context.Items.Remove(ItemKey);
        }
        else
        {
            context.Items[ItemKey] = visitorId;
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
                context.Items[ItemKey] = previous!;
            }
            else
            {
                context.Items.Remove(ItemKey);
            }
        }
    }

    private static string? Resolve(HttpRequestData request)
    {
        var headers = request.Headers.TryGetValues(CekatConstants.VisitorHeader, out var headerValues) ? headerValues : [];
        var rawCookies = request.Headers.TryGetValues("Cookie", out var cookieHeaders) ? cookieHeaders.SelectMany(VisitorIdResolver.CookieValues) : [];
        var parsedCookies = request.Cookies.Where(cookie => cookie.Name == CekatConstants.VisitorCookie).Select(cookie => cookie.Value);
        return VisitorIdResolver.FromHeadersAndCookies(headers, rawCookies.Concat(parsedCookies));
    }
}
