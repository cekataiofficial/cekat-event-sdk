namespace Cekat.EventSdk;

/// <summary>Applies the visitor precedence rules shared by every Cekat SDK.</summary>
public static class VisitorIdResolver
{
    /// <summary>Returns the trimmed value, or <see langword="null"/> when blank.</summary>
    public static string? Normalize(string? visitorId)
    {
        var trimmed = visitorId?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    /// <summary>A nonblank header value wins over a nonblank cookie value.</summary>
    public static string? FromHeaderAndCookie(string? header, string? cookie) => Normalize(header) ?? Normalize(cookie);

    /// <summary>Returns the first nonblank header value, then the first nonblank cookie value.</summary>
    public static string? FromHeadersAndCookies(IEnumerable<string?> headers, IEnumerable<string?> cookies)
    {
        ArgumentNullException.ThrowIfNull(headers);
        ArgumentNullException.ThrowIfNull(cookies);
        return headers.Select(Normalize).FirstOrDefault(value => value is not null)
            ?? cookies.Select(Normalize).FirstOrDefault(value => value is not null);
    }

    /// <summary>
    /// Returns every <c>_cekat_visitor_id</c> value in a raw <c>Cookie</c> header, undecoded, in order.
    /// </summary>
    public static IEnumerable<string> CookieValues(string? cookieHeader)
    {
        if (string.IsNullOrEmpty(cookieHeader))
        {
            yield break;
        }

        foreach (var pair in cookieHeader.Split(';'))
        {
            var separator = pair.IndexOf('=', StringComparison.Ordinal);
            if (separator > 0 && pair.AsSpan(0, separator).Trim().SequenceEqual(CekatConstants.VisitorCookie))
            {
                yield return pair[(separator + 1)..];
            }
        }
    }

    /// <summary>A nonblank explicit visitor ID wins over the context.</summary>
    public static string? ForEvent(string? explicitVisitorId, IVisitorContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        return Normalize(explicitVisitorId) ?? Normalize(context.CurrentVisitorId);
    }
}
