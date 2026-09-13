namespace Cekat.EventSdk;

/// <summary>Configuration for <see cref="CekatClient"/>. Only <see cref="AccessToken"/> is required.</summary>
public sealed class CekatClientOptions
{
    /// <summary>The server-side Cekat access token. Never expose it to browser or mobile code.</summary>
    public string? AccessToken { get; set; }

    /// <summary>An absolute HTTP(S) origin without credentials, path, query, or fragment.</summary>
    public Uri BaseUrl { get; set; } = new(CekatConstants.DefaultBaseUrl);

    /// <summary>The time allowed for each attempt, covering the connection, response headers, and body. Defaults to 3 seconds.</summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(3);

    /// <summary>The number of retries after the first attempt. Defaults to 2; 0 disables retries.</summary>
    public int RetryCount { get; set; } = 2;

    /// <inheritdoc />
    public override string ToString() => $"CekatClientOptions {{ BaseUrl = {BaseUrl}, Timeout = {Timeout}, RetryCount = {RetryCount} }}";
}
