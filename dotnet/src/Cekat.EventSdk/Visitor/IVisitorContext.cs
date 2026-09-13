namespace Cekat.EventSdk;

/// <summary>Supplies the visitor ID of the current request or explicit scope.</summary>
public interface IVisitorContext
{
    /// <summary>The trimmed visitor ID, or <see langword="null"/> when there is none.</summary>
    string? CurrentVisitorId { get; }
}
