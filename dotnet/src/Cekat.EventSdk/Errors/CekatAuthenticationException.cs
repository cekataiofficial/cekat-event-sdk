using System.Net;

namespace Cekat.EventSdk;

/// <summary>HTTP 401: Cekat rejected the access token.</summary>
public sealed class CekatAuthenticationException : CekatApiException
{
    internal CekatAuthenticationException(string message, string? code, byte[] rawBody, int attempts)
        : base(HttpStatusCode.Unauthorized, message, code, rawBody, attempts)
    {
    }
}
