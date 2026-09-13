namespace Cekat.EventSdk.Internal;

internal sealed record ValidatedOptions(string AccessToken, Uri Endpoint, TimeSpan Timeout, int RetryCount)
{
    public override string ToString() => $"ValidatedOptions {{ Endpoint = {Endpoint}, Timeout = {Timeout}, RetryCount = {RetryCount} }}";
}

internal static class OptionsValidator
{
    private static readonly TimeSpan MaximumTimeout = TimeSpan.FromMilliseconds(int.MaxValue);

    public static ValidatedOptions Validate(CekatClientOptions? options)
    {
        if (options is null)
        {
            throw new CekatValidationException("options are required");
        }

        if (string.IsNullOrWhiteSpace(options.AccessToken))
        {
            throw new CekatValidationException("access token must be a non-empty string");
        }

        if (options.Timeout <= TimeSpan.Zero || options.Timeout > MaximumTimeout)
        {
            throw new CekatValidationException("timeout must be greater than zero and at most int.MaxValue milliseconds");
        }

        if (options.RetryCount < 0)
        {
            throw new CekatValidationException("retry count must not be negative");
        }

        return new ValidatedOptions(options.AccessToken, new Uri(NormalizeOrigin(options.BaseUrl), CekatConstants.IngestPath), options.Timeout, options.RetryCount);
    }

    public static Uri NormalizeOrigin(Uri? baseUrl)
    {
        var invalid = new CekatValidationException("base URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment");
        if (baseUrl is null || !baseUrl.IsAbsoluteUri)
        {
            throw invalid;
        }

        var original = baseUrl.OriginalString;
        if ((baseUrl.Scheme != Uri.UriSchemeHttp && baseUrl.Scheme != Uri.UriSchemeHttps)
            || baseUrl.UserInfo.Length > 0
            || baseUrl.AbsolutePath != "/"
            || baseUrl.Query.Length > 0
            || baseUrl.Fragment.Length > 0
            || original.Contains('?', StringComparison.Ordinal)
            || original.Contains('#', StringComparison.Ordinal)
            || original.Contains('@', StringComparison.Ordinal))
        {
            throw invalid;
        }

        return new UriBuilder(baseUrl.Scheme, baseUrl.Host, baseUrl.Port, "/").Uri;
    }
}

/// <summary>Shared by the framework registration helpers so invalid options fail at startup.</summary>
internal static class ServiceRegistration
{
    public static CekatClientOptions ConfigureAndValidate(Action<CekatClientOptions> configure)
    {
        ArgumentNullException.ThrowIfNull(configure);
        var options = new CekatClientOptions();
        configure(options);
        OptionsValidator.Validate(options);
        return options;
    }
}
