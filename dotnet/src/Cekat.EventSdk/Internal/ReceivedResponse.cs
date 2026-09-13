namespace Cekat.EventSdk.Internal;

/// <summary>A response whose status arrived. <see cref="Body"/> holds at most 65,536 bytes.</summary>
internal sealed record ReceivedResponse(
    int StatusCode,
    string? ReasonPhrase,
    string? RetryAfter,
    byte[] Body,
    bool BodyTruncated,
    int ObservedBodyBytes,
    Exception? BodyReadFailure);
