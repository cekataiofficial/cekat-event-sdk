using System.Net;

namespace Cekat.EventSdk;

/// <summary>HTTP 404: the tenant has no definition for the event key.</summary>
public sealed class CekatEventDefinitionNotFoundException : CekatApiException
{
    internal CekatEventDefinitionNotFoundException(string message, string? code, byte[] rawBody, int attempts)
        : base(HttpStatusCode.NotFound, message, code, rawBody, attempts)
    {
    }
}
