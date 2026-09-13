namespace Cekat.EventSdk;

/// <summary>
/// Cekat accepted the event for asynchronous processing. This does not confirm durable storage,
/// identity resolution, or analytics availability.
/// </summary>
/// <param name="Success">Always <see langword="true"/>.</param>
/// <param name="Message">The server message.</param>
/// <param name="EventKey">The accepted event key.</param>
/// <param name="ValidatedProperties">The property names the server validated.</param>
/// <param name="RawBody">The response body.</param>
public sealed record Acknowledgement(
    bool Success,
    string Message,
    string EventKey,
    IReadOnlyList<string> ValidatedProperties,
    string RawBody);
