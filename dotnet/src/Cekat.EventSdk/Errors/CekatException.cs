namespace Cekat.EventSdk;

/// <summary>The base class for every SDK error. Messages never contain the access token.</summary>
public abstract class CekatException : Exception
{
    private protected CekatException(string message, int attempts, Exception? innerException = null)
        : base(message, innerException)
    {
        Attempts = attempts;
    }

    /// <summary>The number of HTTP attempts made. Zero for validation errors.</summary>
    public int Attempts { get; }

    /// <summary>
    /// <see langword="true"/> when no response was received, so Cekat may still have received the event
    /// and resending it can create a duplicate.
    /// </summary>
    public virtual bool DeliveryOutcomeUnknown => false;
}
