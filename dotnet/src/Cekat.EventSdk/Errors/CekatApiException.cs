using System.Net;
using System.Text;

namespace Cekat.EventSdk;

/// <summary>Cekat returned a non-200 response. The delivery outcome is known.</summary>
public class CekatApiException : CekatException
{
    private readonly byte[] _rawBody;

    internal CekatApiException(HttpStatusCode statusCode, string message, string? code, byte[] rawBody, int attempts)
        : base(message, attempts)
    {
        StatusCode = statusCode;
        Code = code;
        _rawBody = rawBody;
    }

    /// <summary>The HTTP status code.</summary>
    public HttpStatusCode StatusCode { get; }

    /// <summary>The server's optional error code.</summary>
    public string? Code { get; }

    /// <summary>The retained response body (at most 65,536 bytes) decoded as UTF-8 with replacement characters.</summary>
    public string RawBody => Encoding.UTF8.GetString(_rawBody);

    /// <summary>Returns a copy of the retained response body bytes (at most 65,536).</summary>
    public byte[] GetRawBodyBytes() => (byte[])_rawBody.Clone();
}
