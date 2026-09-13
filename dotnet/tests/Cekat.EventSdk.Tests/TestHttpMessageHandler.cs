using System.Net;
using System.Text;
using System.Text.Json;

namespace Cekat.EventSdk.Tests;

internal sealed class TestHttpMessageHandler : HttpMessageHandler
{
    public const string Success = """{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}""";

    private readonly Queue<Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>> _responses = new();

    public List<HttpRequestMessage> Requests { get; } = [];

    public List<JsonDocument> Bodies { get; } = [];

    public bool Disposed { get; private set; }

    public JsonElement Body => Bodies[^1].RootElement;

    public TestHttpMessageHandler Respond(HttpStatusCode status, string body = Success, Action<HttpResponseMessage>? configure = null)
    {
        _responses.Enqueue((_, _) =>
        {
            var response = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            configure?.Invoke(response);
            return Task.FromResult(response);
        });
        return this;
    }

    public TestHttpMessageHandler Respond(HttpStatusCode status, Stream body)
    {
        _responses.Enqueue((_, _) => Task.FromResult(new HttpResponseMessage(status) { Content = new StreamContent(body) }));
        return this;
    }

    public TestHttpMessageHandler Throw(Exception error)
    {
        _responses.Enqueue((_, _) => Task.FromException<HttpResponseMessage>(error));
        return this;
    }

    public TestHttpMessageHandler Respond(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond)
    {
        _responses.Enqueue(respond);
        return this;
    }

    public static CekatClientOptions Options(int retryCount = 2, TimeSpan? timeout = null) => new()
    {
        AccessToken = "secret-token",
        BaseUrl = new Uri("https://example.test/"),
        RetryCount = retryCount,
        Timeout = timeout ?? TimeSpan.FromSeconds(3),
    };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        Bodies.Add(JsonDocument.Parse(await request.Content!.ReadAsByteArrayAsync(cancellationToken)));
        return await _responses.Dequeue()(request, cancellationToken);
    }

    protected override void Dispose(bool disposing)
    {
        Disposed = true;
        base.Dispose(disposing);
    }
}

/// <summary>A response body that fails after sending a prefix.</summary>
internal sealed class InterruptedStream(byte[] prefix) : MemoryStream(prefix)
{
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        var read = await base.ReadAsync(buffer, cancellationToken);
        return read > 0 ? read : throw new IOException("connection reset");
    }
}

/// <summary>Counts how many chunks a bounded reader consumed.</summary>
internal sealed class ChunkedStream(params byte[][] chunks) : Stream
{
    private int _next;
    private int _offset;

    public int Consumed => _next;

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (_offset == 0 && _next == chunks.Length)
        {
            return ValueTask.FromResult(0);
        }

        var chunk = chunks[_offset == 0 ? _next++ : _next - 1];
        var count = Math.Min(buffer.Length, chunk.Length - _offset);
        chunk.AsSpan(_offset, count).CopyTo(buffer.Span);
        _offset = _offset + count == chunk.Length ? 0 : _offset + count;
        return ValueTask.FromResult(count);
    }

    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

internal sealed class FixedVisitorContext(string? visitorId) : IVisitorContext
{
    public string? CurrentVisitorId => visitorId;
}

internal sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => now;
}

internal static class TestClients
{
    public static CekatClient Create(TestHttpMessageHandler handler, List<TimeSpan>? delays = null, CekatClientOptions? options = null, IVisitorContext? context = null, TimeProvider? time = null) =>
        new(
            options ?? TestHttpMessageHandler.Options(),
            new HttpClient(handler),
            context,
            jitter: upperBound => upperBound,
            delay: (duration, token) =>
            {
                delays?.Add(duration);
                return Task.CompletedTask;
            },
            time);
}
