namespace Cekat.EventSdk;

/// <summary>
/// An identity-bearing event. At least one of <see cref="Email"/> or <see cref="PhoneNumber"/> must be nonblank.
/// Identity strings are sent unchanged; they are trimmed only to check for blank values.
/// </summary>
/// <param name="Email">The contact email address.</param>
/// <param name="PhoneNumber">The contact phone number.</param>
/// <param name="ContactName">The contact display name.</param>
/// <param name="Properties">
/// A string-keyed object: an <c>IDictionary</c> with string keys, an
/// <c>IEnumerable&lt;KeyValuePair&lt;string, object?&gt;&gt;</c>, a <c>JsonObject</c>, or an object <c>JsonElement</c>.
/// Values may be null, booleans, strings, finite numbers within ±9,007,199,254,740,991 when integral, lists, and nested objects.
/// </param>
/// <param name="VisitorId">An explicit visitor ID. When blank, the current visitor context is used.</param>
/// <param name="EventId">A deduplication ID. When blank, the SDK generates a random UUID reused by every retry.</param>
/// <param name="OccurredAt">When the event happened. Defaults to the time of the call.</param>
public sealed record EventInput(
    string? Email = null,
    string? PhoneNumber = null,
    string? ContactName = null,
    object? Properties = null,
    string? VisitorId = null,
    string? EventId = null,
    DateTimeOffset? OccurredAt = null);
