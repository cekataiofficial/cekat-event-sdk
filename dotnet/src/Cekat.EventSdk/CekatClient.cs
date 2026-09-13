using System.Net.Http.Headers;
using Cekat.EventSdk.Internal;

namespace Cekat.EventSdk;

/// <summary>
/// Submits events to Cekat. Thread-safe; create one instance per application and reuse it.
/// </summary>
/// <remarks>
/// A client created without an <see cref="HttpClient"/> owns its connection pool and releases it on
/// <see cref="Dispose"/>. An injected <see cref="HttpClient"/> is never disposed by the SDK.
/// </remarks>
public sealed class CekatClient : IDisposable
{
    private static readonly string UserAgent = $"cekat-event-sdk-dotnet/{CekatConstants.Version} dotnet/{Environment.Version}";
    private static readonly MediaTypeHeaderValue JsonContentType = new("application/json");

    private readonly ValidatedOptions _options;
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly IVisitorContext? _visitorContext;
    private readonly Func<double, double> _jitter;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly TimeProvider _time;

    /// <summary>Creates a client.</summary>
    /// <param name="options">Client configuration; <see cref="CekatClientOptions.AccessToken"/> is required.</param>
    /// <param name="httpClient">An optional caller-owned HTTP client (for proxies, TLS, or handlers). Its own timeout also applies.</param>
    /// <param name="visitorContext">
    /// A request visitor source, such as the ASP.NET Core or Azure Functions context. An explicit
    /// <see cref="EventInput.VisitorId"/> wins, then an <see cref="AsyncLocalVisitorContext"/> scope, then this context.
    /// </param>
    /// <exception cref="CekatValidationException">The options are invalid.</exception>
    public CekatClient(CekatClientOptions options, HttpClient? httpClient = null, IVisitorContext? visitorContext = null)
        : this(options, httpClient, visitorContext, jitter: null, delay: null, time: null)
    {
    }

    internal CekatClient(
        CekatClientOptions options,
        HttpClient? httpClient,
        IVisitorContext? visitorContext,
        Func<double, double>? jitter,
        Func<TimeSpan, CancellationToken, Task>? delay,
        TimeProvider? time)
    {
        _options = OptionsValidator.Validate(options);
        _ownsHttp = httpClient is null;
        _http = httpClient ?? new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), AllowAutoRedirect = false })
        {
            Timeout = System.Threading.Timeout.InfiniteTimeSpan,
        };
        _visitorContext = visitorContext;
        _jitter = jitter ?? (upperBound => Random.Shared.NextDouble() * upperBound);
        _delay = delay ?? ((duration, token) => Task.Delay(duration, token));
        _time = time ?? TimeProvider.System;
    }

    /// <summary>Tracks <c>user_registration</c>.</summary>
    /// <exception cref="CekatException">The event was invalid, rejected, or could not be delivered.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public Task<Acknowledgement> UserRegistrationAsync(EventInput input, CancellationToken cancellationToken = default) =>
        TrackAsync("user_registration", true, () => input, cancellationToken);

    /// <summary>Tracks <c>user_login</c>.</summary>
    /// <exception cref="CekatException">The event was invalid, rejected, or could not be delivered.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public Task<Acknowledgement> UserLoginAsync(EventInput input, CancellationToken cancellationToken = default) =>
        TrackAsync("user_login", true, () => input, cancellationToken);

    /// <summary>Tracks <c>order_created</c>.</summary>
    /// <exception cref="CekatException">The event was invalid, rejected, or could not be delivered.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public Task<Acknowledgement> OrderCreatedAsync(EventInput input, CancellationToken cancellationToken = default) =>
        TrackAsync("order_created", true, () => input, cancellationToken);

    /// <summary>Tracks <c>order_paid</c>, sending <paramref name="amount"/> and <paramref name="currency"/> as properties.</summary>
    /// <param name="amount">The paid amount, sent as <c>properties.amount</c>.</param>
    /// <param name="currency">A nonblank currency, sent unchanged as <c>properties.currency</c>.</param>
    /// <param name="input">The event; its properties must not contain <c>amount</c> or <c>currency</c>.</param>
    /// <param name="cancellationToken">Cancels the request or retry delay.</param>
    /// <exception cref="CekatException">The event was invalid, rejected, or could not be delivered.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public Task<Acknowledgement> OrderPaidAsync(decimal amount, string currency, EventInput input, CancellationToken cancellationToken = default) =>
        TrackAsync("order_paid", true, () => EventPayload.WithOrderPaidProperties(amount, currency, input), cancellationToken);

    /// <summary>Tracks a tenant-defined event.</summary>
    /// <exception cref="CekatException">The event was invalid, rejected, or could not be delivered.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public Task<Acknowledgement> CustomEventAsync(string eventKey, EventInput input, CancellationToken cancellationToken = default) =>
        TrackAsync(eventKey, false, () => input, cancellationToken);

    /// <summary>Runs <paramref name="action"/> with <paramref name="visitorId"/> as the current visitor.</summary>
    public static async Task<T> WithVisitorIdAsync<T>(string? visitorId, Func<CancellationToken, Task<T>> action, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(action);
        using var scope = AsyncLocalVisitorContext.Push(visitorId);
        return await action(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Releases the SDK-created connection pool. An injected <see cref="HttpClient"/> is left open.</summary>
    public void Dispose()
    {
        if (_ownsHttp)
        {
            _http.Dispose();
        }
    }

    /// <inheritdoc />
    public override string ToString() => $"CekatClient {{ Endpoint = {_options.Endpoint} }}";

    private async Task<Acknowledgement> TrackAsync(string eventKey, bool isCommon, Func<EventInput> input, CancellationToken cancellationToken)
    {
        // Runs inside the returned task so validation errors fault the task instead of throwing synchronously.
        await Task.Yield();
        var body = EventPayload.Build(eventKey, isCommon, input(), CurrentVisitorId(), _time.GetUtcNow, () => Guid.NewGuid().ToString("D"));
        var attempts = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            attempts++;
            ReceivedResponse response;
            try
            {
                response = await AttemptAsync(body, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception error) when (IsTransportFailure(error, cancellationToken))
            {
                if (attempts > _options.RetryCount)
                {
                    throw new CekatTransportException(
                        $"no response from Cekat after {attempts} {(attempts == 1 ? "attempt" : "attempts")} ({error.GetType().Name}); the event may have been received",
                        attempts,
                        error);
                }

                await _delay(RetryPolicy.RetryDelay(attempts, null, _jitter, _time.GetUtcNow()) ?? TimeSpan.Zero, cancellationToken).ConfigureAwait(false);
                continue;
            }

            if (RetryPolicy.IsRetryableStatus(response.StatusCode) && attempts <= _options.RetryCount
                && RetryPolicy.RetryDelay(attempts, response.RetryAfter, _jitter, _time.GetUtcNow()) is { } delay)
            {
                await _delay(delay, cancellationToken).ConfigureAwait(false);
                continue;
            }

            return ResponseDecoder.Decode(response, attempts);
        }
    }

    private string? CurrentVisitorId() =>
        AsyncLocalVisitorContext.Shared.CurrentVisitorId ?? VisitorIdResolver.Normalize(_visitorContext?.CurrentVisitorId);

    private static bool IsTransportFailure(Exception error, CancellationToken cancellationToken) =>
        error is HttpRequestException or IOException || (error is OperationCanceledException && !cancellationToken.IsCancellationRequested);

    private async Task<ReceivedResponse> AttemptAsync(byte[] body, CancellationToken cancellationToken)
    {
        using var attemptCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        attemptCancellation.CancelAfter(_options.Timeout);
        var token = attemptCancellation.Token;

        using var request = new HttpRequestMessage(HttpMethod.Post, _options.Endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.AccessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
        request.Content = new ByteArrayContent(body);
        request.Content.Headers.ContentType = JsonContentType;

        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
        var retained = new byte[CekatConstants.MaximumResponseBodyBytes + 1];
        var observed = 0;
        Exception? failure = null;
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
            int read;
            while (observed < retained.Length && (read = await stream.ReadAsync(retained.AsMemory(observed), token).ConfigureAwait(false)) > 0)
            {
                observed += read;
            }
        }
        catch (Exception error) when (IsTransportFailure(error, cancellationToken))
        {
            failure = error;
        }

        var truncated = observed > CekatConstants.MaximumResponseBodyBytes;
        return new ReceivedResponse(
            (int)response.StatusCode,
            // HTTP/2 and HTTP/3 have no reason phrase; .NET would substitute its own legacy text.
            response.Version.Major < 2 ? response.ReasonPhrase : null,
            response.Headers.NonValidated.TryGetValues("Retry-After", out var retryAfter) ? retryAfter.FirstOrDefault() : null,
            retained.AsSpan(0, Math.Min(observed, CekatConstants.MaximumResponseBodyBytes)).ToArray(),
            truncated,
            observed,
            truncated ? null : failure);
    }
}
