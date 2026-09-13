namespace Cekat.EventSdk;

/// <summary>Invalid configuration or event input, detected before any request was sent.</summary>
public sealed class CekatValidationException : CekatException
{
    internal CekatValidationException(string message)
        : base(message, 0)
    {
    }
}
