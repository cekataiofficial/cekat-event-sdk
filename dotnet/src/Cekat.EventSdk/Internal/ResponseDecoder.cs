using System.Net;
using System.Text;
using System.Text.Json;

namespace Cekat.EventSdk.Internal;

internal static class ResponseDecoder
{
    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private static readonly Dictionary<int, string> StatusText = new()
    {
        [400] = "Bad Request",
        [401] = "Unauthorized",
        [403] = "Forbidden",
        [404] = "Not Found",
        [405] = "Method Not Allowed",
        [408] = "Request Timeout",
        [409] = "Conflict",
        [413] = "Content Too Large",
        [415] = "Unsupported Media Type",
        [418] = "I'm a teapot",
        [422] = "Unprocessable Content",
        [429] = "Too Many Requests",
        [500] = "Internal Server Error",
        [501] = "Not Implemented",
        [502] = "Bad Gateway",
        [503] = "Service Unavailable",
        [504] = "Gateway Timeout",
    };

    /// <summary>Returns the acknowledgement for a valid 200 or throws the typed error for the response.</summary>
    public static Acknowledgement Decode(ReceivedResponse response, int attempts)
    {
        if (response.StatusCode == 200)
        {
            return DecodeSuccess(response, attempts);
        }

        string? message = null;
        string? code = null;
        using (var document = Parse(response.Body))
        {
            if (document?.RootElement is { ValueKind: JsonValueKind.Object } root
                && root.TryGetProperty("success", out var success) && success.ValueKind == JsonValueKind.False
                && root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String && error.GetString() is { Length: > 0 } errorText)
            {
                var hasCode = root.TryGetProperty("code", out var codeElement);
                if (!hasCode || codeElement.ValueKind == JsonValueKind.String)
                {
                    message = errorText;
                    code = hasCode ? codeElement.GetString() : null;
                }
            }
        }

        message ??= !string.IsNullOrWhiteSpace(response.ReasonPhrase)
            ? response.ReasonPhrase.Trim()
            : StatusText.GetValueOrDefault(response.StatusCode, $"HTTP {response.StatusCode}");

        throw response.StatusCode switch
        {
            401 => new CekatAuthenticationException(message, code, response.Body, attempts),
            404 => new CekatEventDefinitionNotFoundException(message, code, response.Body, attempts),
            _ => new CekatApiException((HttpStatusCode)response.StatusCode, message, code, response.Body, attempts),
        };
    }

    private static Acknowledgement DecodeSuccess(ReceivedResponse response, int attempts)
    {
        if (response.BodyReadFailure is not null)
        {
            throw new CekatResponseDecodeException("response body could not be read", response.Body, attempts, response.BodyReadFailure);
        }

        if (response.BodyTruncated)
        {
            throw new CekatResponseDecodeException($"response body exceeds {CekatConstants.MaximumResponseBodyBytes} bytes", response.Body, attempts);
        }

        using var document = Parse(response.Body);
        if (document?.RootElement is { ValueKind: JsonValueKind.Object } root
            && root.TryGetProperty("success", out var outer) && outer.ValueKind == JsonValueKind.True
            && root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object
            && data.TryGetProperty("success", out var inner) && inner.ValueKind == JsonValueKind.True
            && NonEmptyString(data, "message") is { } message
            && NonEmptyString(data, "event_key") is { } eventKey
            && data.TryGetProperty("validated_properties", out var validated) && validated.ValueKind == JsonValueKind.Array
            && validated.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String))
        {
            var properties = validated.EnumerateArray().Select(item => item.GetString()!).ToArray();
            return new Acknowledgement(true, message, eventKey, Array.AsReadOnly(properties), Encoding.UTF8.GetString(response.Body));
        }

        throw new CekatResponseDecodeException("response body is not a valid success envelope", response.Body, attempts);
    }

    private static string? NonEmptyString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } text ? text : null;

    private static JsonDocument? Parse(byte[] body)
    {
        try
        {
            StrictUtf8.GetCharCount(body);
            return JsonDocument.Parse(body);
        }
        catch (Exception error) when (error is JsonException or DecoderFallbackException or ArgumentException)
        {
            return null;
        }
    }
}
