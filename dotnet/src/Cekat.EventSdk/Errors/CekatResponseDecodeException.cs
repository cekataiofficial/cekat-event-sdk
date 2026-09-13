using System.Net;
using System.Text;

namespace Cekat.EventSdk;

/// <summary>HTTP 200 whose body was invalid, over 65,536 bytes, or unreadable. The event was received.</summary>
public sealed class CekatResponseDecodeException : CekatException
{
    private readonly byte[] _rawBody;

    internal CekatResponseDecodeException(string message, byte[] rawBody, int attempts, Exception? innerException = null)
        : base(message, attempts, innerException)
    {
        _rawBody = rawBody;
    }

    /// <summary>Always <see cref="HttpStatusCode.OK"/>.</summary>
    public HttpStatusCode StatusCode { get; } = HttpStatusCode.OK;

    /// <summary>The retained response body decoded as UTF-8 with replacement characters.</summary>
    public string RawBody => Encoding.UTF8.GetString(_rawBody);

    /// <summary>Returns a copy of the retained response body bytes (at most 65,536).</summary>
    public byte[] GetRawBodyBytes() => (byte[])_rawBody.Clone();
}
