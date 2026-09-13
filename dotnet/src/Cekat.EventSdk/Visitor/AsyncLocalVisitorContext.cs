namespace Cekat.EventSdk;

/// <summary>
/// A visitor scope that flows with the <see cref="ExecutionContext"/>: awaited calls and tasks started
/// inside a scope observe it, and disposing the scope restores the previous visitor.
/// Visitor IDs are untrusted correlation data; never use them for authentication or authorization.
/// </summary>
public sealed class AsyncLocalVisitorContext : IVisitorContext
{
    private static readonly AsyncLocal<string?> Current = new();

    private AsyncLocalVisitorContext()
    {
    }

    /// <summary>An <see cref="IVisitorContext"/> view of the current scope.</summary>
    public static AsyncLocalVisitorContext Shared { get; } = new();

    /// <inheritdoc />
    public string? CurrentVisitorId => Current.Value;

    /// <summary>Makes <paramref name="visitorId"/> (trimmed; blank means none) current until the returned scope is disposed.</summary>
    public static IDisposable Push(string? visitorId)
    {
        var previous = Current.Value;
        Current.Value = VisitorIdResolver.Normalize(visitorId);
        return new Scope(previous);
    }

    private sealed class Scope(string? previous) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                Current.Value = previous;
            }
        }
    }
}
