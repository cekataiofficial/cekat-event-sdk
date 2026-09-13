using Microsoft.AspNetCore.Http;

namespace Cekat.EventSdk.AspNetCore;

/// <summary>Reads the visitor ID that <see cref="CekatVisitorMiddleware"/> stored in <see cref="HttpContext.Items"/>.</summary>
public sealed class AspNetCoreVisitorContext(IHttpContextAccessor accessor) : IVisitorContext
{
    /// <summary>The <see cref="HttpContext.Items"/> key holding the request's trimmed visitor ID.</summary>
    public const string ItemKey = "Cekat.EventSdk.VisitorId";

    /// <inheritdoc />
    public string? CurrentVisitorId
    {
        get
        {
            try
            {
                return accessor.HttpContext?.Items.TryGetValue(ItemKey, out var value) == true ? value as string : null;
            }
            catch (ObjectDisposedException)
            {
                // The request finished; background work keeps the visitor through the AsyncLocal scope instead.
                return null;
            }
        }
    }

    /// <summary>Returns the visitor ID stored for <paramref name="context"/>, if any.</summary>
    public static string? FromHttpContext(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        return context.Items.TryGetValue(ItemKey, out var value) ? value as string : null;
    }
}
