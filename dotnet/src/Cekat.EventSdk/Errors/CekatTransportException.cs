namespace Cekat.EventSdk;

/// <summary>
/// No response was received after all attempts (connection failures or timeouts).
/// Cekat may still have received the event.
/// </summary>
public sealed class CekatTransportException : CekatException
{
    internal CekatTransportException(string message, int attempts, Exception innerException)
        : base(message, attempts, innerException)
    {
    }

    /// <inheritdoc />
    public override bool DeliveryOutcomeUnknown => true;
}
