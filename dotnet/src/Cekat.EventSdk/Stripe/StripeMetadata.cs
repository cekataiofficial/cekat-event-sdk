using System.Collections.ObjectModel;

namespace Cekat.EventSdk;

/// <summary>Builds native Stripe metadata for optional Cekat visitor correlation.</summary>
public static class StripeMetadata
{
    private const string VisitorMetadataKey = "cekat_visitor_id";

    /// <summary>Returns fresh read-only metadata for a valid explicit visitor.</summary>
    public static IReadOnlyDictionary<string, string> ForVisitor(string? visitorId)
    {
        var normalizedVisitorId = ValidVisitorId(visitorId);
        return normalizedVisitorId is null
            ? EmptyMetadata()
            : ReadOnlyMetadata(new Dictionary<string, string> { [VisitorMetadataKey] = normalizedVisitorId });
    }

    /// <summary>Returns fresh read-only metadata from the supplied or shared visitor scope.</summary>
    public static IReadOnlyDictionary<string, string> FromCurrentVisitor(IVisitorContext? context = null)
    {
        return ForVisitor((context ?? AsyncLocalVisitorContext.Shared).CurrentVisitorId);
    }

    /// <summary>Copies metadata and replaces only the Cekat visitor key when the visitor is valid.</summary>
    public static IReadOnlyDictionary<string, string> MergeMetadata(IReadOnlyDictionary<string, string> metadata, string? visitorId)
    {
        var merged = new Dictionary<string, string>(metadata);
        var normalizedVisitorId = ValidVisitorId(visitorId);
        if (normalizedVisitorId is not null)
        {
            merged[VisitorMetadataKey] = normalizedVisitorId;
        }
        return ReadOnlyMetadata(merged);
    }

    private static string? ValidVisitorId(string? visitorId)
    {
        var normalizedVisitorId = visitorId?.Trim();
        if (string.IsNullOrEmpty(normalizedVisitorId) || normalizedVisitorId.Length > 128)
        {
            return null;
        }
        foreach (var character in normalizedVisitorId)
        {
            if (!char.IsAsciiLetterOrDigit(character) && character is not '_' and not '-')
            {
                return null;
            }
        }
        return normalizedVisitorId;
    }

    private static ReadOnlyDictionary<string, string> EmptyMetadata()
    {
        return ReadOnlyMetadata(new Dictionary<string, string>());
    }

    private static ReadOnlyDictionary<string, string> ReadOnlyMetadata(Dictionary<string, string> metadata)
    {
        return new ReadOnlyDictionary<string, string>(metadata);
    }
}
