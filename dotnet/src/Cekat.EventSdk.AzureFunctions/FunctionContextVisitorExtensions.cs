using Cekat.EventSdk.AzureFunctions;

namespace Microsoft.Azure.Functions.Worker;

/// <summary>Reads the visitor ID stored by <see cref="CekatFunctionsVisitorMiddleware"/>.</summary>
public static class FunctionContextVisitorExtensions
{
    /// <summary>Returns the invocation's trimmed visitor ID, or <see langword="null"/>.</summary>
    public static string? GetCekatVisitorId(this FunctionContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        return context.Items.TryGetValue(CekatFunctionsVisitorMiddleware.ItemKey, out var value) ? value as string : null;
    }
}
