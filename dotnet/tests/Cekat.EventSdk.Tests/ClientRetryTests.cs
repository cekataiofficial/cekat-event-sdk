using System.Globalization;
using System.Net;
using Cekat.EventSdk.Internal;

namespace Cekat.EventSdk.Tests;

public sealed class ClientRetryTests
{
    private static readonly EventInput Input = new(Email: "a@example.test");

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.GatewayTimeout)]
    public async Task Retryable_statuses_retry_with_the_same_event(HttpStatusCode status)
    {
        var delays = new List<TimeSpan>();
        var handler = new TestHttpMessageHandler().Respond(status, "{}").Respond(status, "{}").Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler, delays);
        await client.CustomEventAsync("k", Input);
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal([TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(200)], delays);
        Assert.Single(handler.Bodies.Select(body => body.RootElement.GetRawText()).Distinct());
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.Conflict)]
    public async Task Other_statuses_are_not_retried(HttpStatusCode status)
    {
        var handler = new TestHttpMessageHandler().Respond(status, "{}").Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler);
        var error = await Assert.ThrowsAnyAsync<CekatApiException>(() => client.CustomEventAsync("k", Input));
        Assert.Equal(1, error.Attempts);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Exhausted_retries_raise_the_last_status()
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.BadGateway, "{}").Respond(HttpStatusCode.ServiceUnavailable, "{}").Respond(HttpStatusCode.GatewayTimeout, "{}");
        using var client = TestClients.Create(handler);
        var error = await Assert.ThrowsAsync<CekatApiException>(() => client.CustomEventAsync("k", Input));
        Assert.Equal((HttpStatusCode.GatewayTimeout, 3, "Gateway Timeout"), (error.StatusCode, error.Attempts, error.Message));
    }

    [Fact]
    public async Task Retry_after_raises_the_delay_and_long_values_stop_retrying()
    {
        var delays = new List<TimeSpan>();
        var handler = new TestHttpMessageHandler()
            .Respond(HttpStatusCode.TooManyRequests, "{}", response => response.Headers.TryAddWithoutValidation("Retry-After", "2"))
            .Respond(HttpStatusCode.ServiceUnavailable, "{}", response => response.Headers.TryAddWithoutValidation("Retry-After", "6"))
            .Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler, delays);
        var error = await Assert.ThrowsAsync<CekatApiException>(() => client.CustomEventAsync("k", Input));
        Assert.Equal([TimeSpan.FromSeconds(2)], delays);
        Assert.Equal((HttpStatusCode.ServiceUnavailable, 2), (error.StatusCode, error.Attempts));
    }

    [Fact]
    public async Task Transport_failures_retry_then_report_unknown_outcome()
    {
        var delays = new List<TimeSpan>();
        var handler = new TestHttpMessageHandler()
            .Throw(new HttpRequestException("refused"))
            .Throw(new TaskCanceledException("timeout", new TimeoutException()))
            .Throw(new HttpRequestException("reset", new IOException("reset")));
        using var client = TestClients.Create(handler, delays);
        var error = await Assert.ThrowsAsync<CekatTransportException>(() => client.CustomEventAsync("k", Input));
        Assert.Equal((3, true), (error.Attempts, error.DeliveryOutcomeUnknown));
        Assert.IsType<HttpRequestException>(error.InnerException);
        Assert.Equal(2, delays.Count);
        Assert.DoesNotContain("secret-token", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Attempt_timeout_covers_headers_and_body()
    {
        var handler = new TestHttpMessageHandler()
            .Respond(async (_, token) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(30), token);
                return new HttpResponseMessage(HttpStatusCode.OK);
            })
            .Respond(HttpStatusCode.OK);
        using var client = TestClients.Create(handler, options: TestHttpMessageHandler.Options(timeout: TimeSpan.FromMilliseconds(50)));
        await client.CustomEventAsync("k", Input);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task Zero_retry_count_makes_one_attempt()
    {
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.InternalServerError, "{}");
        using var client = TestClients.Create(handler, options: TestHttpMessageHandler.Options(retryCount: 0));
        await Assert.ThrowsAsync<CekatApiException>(() => client.CustomEventAsync("k", Input));
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Cancellation_before_and_during_the_request_propagates()
    {
        var handler = new TestHttpMessageHandler();
        using var client = TestClients.Create(handler);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.CustomEventAsync("k", Input, new CancellationToken(canceled: true)));
        Assert.Empty(handler.Requests);

        using var cancellation = new CancellationTokenSource();
        var started = new TaskCompletionSource();
        handler.Respond(async (_, token) =>
        {
            started.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        var call = client.CustomEventAsync("k", Input, cancellation.Token);
        await started.Task;
        await cancellation.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => call);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Cancellation_during_backoff_makes_no_further_attempt()
    {
        using var cancellation = new CancellationTokenSource();
        var handler = new TestHttpMessageHandler().Respond(HttpStatusCode.InternalServerError, "{}").Respond(HttpStatusCode.OK);
        using var client = new CekatClient(
            TestHttpMessageHandler.Options(),
            new HttpClient(handler),
            visitorContext: null,
            jitter: bound => bound,
            delay: async (_, token) =>
            {
                await cancellation.CancelAsync();
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
            },
            time: null);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.CustomEventAsync("k", Input, cancellation.Token));
        Assert.Single(handler.Requests);
    }

    [Fact]
    public void Jitter_bounds_double_to_one_second()
    {
        Assert.Equal([100d, 200d, 400d, 800d, 1000d, 1000d], Enumerable.Range(1, 6).Select(RetryPolicy.JitterUpperBoundMilliseconds));
    }

    [Theory]
    [InlineData("0", 0d)]
    [InlineData(" 3 ", 3d)]
    [InlineData("Sun, 13 Sep 2026 00:00:02 GMT", 2d)]
    [InlineData("Sunday, 13-Sep-26 00:00:04 GMT", 4d)]
    [InlineData("Sun Sep 13 00:00:01 2026", 1d)]
    [InlineData("Sat, 12 Sep 2026 23:00:00 GMT", 0d)]
    [InlineData("-1", null)]
    [InlineData("1.5", null)]
    [InlineData("soon", null)]
    [InlineData("", null)]
    [InlineData("Sun, 13 Sep 2026 00:00:02 +0000", null)]
    public void Retry_after_parsing(string value, double? seconds)
    {
        var now = DateTimeOffset.Parse("2026-09-13T00:00:00Z", CultureInfo.InvariantCulture);
        Assert.Equal(seconds is null ? null : TimeSpan.FromSeconds(seconds.Value), RetryPolicy.ParseRetryAfter(value, now));
    }
}
