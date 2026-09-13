using System.Globalization;

namespace Cekat.EventSdk.Internal;

internal static class RetryPolicy
{
    public static readonly TimeSpan MaximumRetryAfter = TimeSpan.FromSeconds(5);

    private static readonly string[] HttpDateFormats =
    [
        "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'", // IMF-fixdate
        "dddd, dd-MMM-yy HH':'mm':'ss 'GMT'", // RFC 850
        "ddd MMM d HH':'mm':'ss yyyy", // asctime, two-digit day
        "ddd MMM  d HH':'mm':'ss yyyy", // asctime, space-padded day
    ];

    public static bool IsRetryableStatus(int statusCode) => statusCode is 429 or 500 or 502 or 503 or 504;

    /// <summary>The full-jitter upper bound in milliseconds before one-indexed retry <paramref name="retryNumber"/>.</summary>
    public static double JitterUpperBoundMilliseconds(int retryNumber) => Math.Min(100 * Math.Pow(2, Math.Clamp(retryNumber, 1, 5) - 1), 1000);

    /// <summary>Parses delta-seconds or an HTTP-date; returns <see langword="null"/> when absent or invalid.</summary>
    public static TimeSpan? ParseRetryAfter(string? value, DateTimeOffset now)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text))
        {
            return null;
        }

        if (text.All(char.IsAsciiDigit))
        {
            return text.Length > 9 ? TimeSpan.MaxValue : TimeSpan.FromSeconds(int.Parse(text, CultureInfo.InvariantCulture));
        }

        if (!DateTimeOffset.TryParseExact(text, HttpDateFormats, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date))
        {
            return null;
        }

        var delay = date - now;
        return delay < TimeSpan.Zero ? TimeSpan.Zero : delay;
    }

    /// <summary>Returns the delay before a retry, or <see langword="null"/> when Retry-After exceeds the 5 second cap.</summary>
    public static TimeSpan? RetryDelay(int retryNumber, string? retryAfter, Func<double, double> jitter, DateTimeOffset now)
    {
        var requested = ParseRetryAfter(retryAfter, now);
        if (requested > MaximumRetryAfter)
        {
            return null;
        }

        var jittered = TimeSpan.FromMilliseconds(jitter(JitterUpperBoundMilliseconds(retryNumber)));
        return requested is { } minimum && minimum > jittered ? minimum : jittered;
    }
}
