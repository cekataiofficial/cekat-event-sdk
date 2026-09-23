namespace Cekat.EventSdk;

/// <summary>Fixed protocol values shared by the SDK packages.</summary>
public static class CekatConstants
{
    /// <summary>The production Cekat origin.</summary>
    public const string DefaultBaseUrl = "https://t.cekat.ai";

    /// <summary>The ingest endpoint path appended to the configured origin.</summary>
    public const string IngestPath = "/api/events/ingest";

    /// <summary>The cookie set by the Cekat browser SDK.</summary>
    public const string VisitorCookie = "_cekat_visitor_id";

    /// <summary>The request header set by the Cekat browser SDK. It takes precedence over the cookie.</summary>
    public const string VisitorHeader = "X-Cekat-Visitor-ID";

    /// <summary>The maximum number of response body bytes retained.</summary>
    public const int MaximumResponseBodyBytes = 65_536;

    /// <summary>The SDK version sent in the User-Agent header.</summary>
    public const string Version = "0.3.0";
}
