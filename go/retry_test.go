package cekat

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"
)

type scriptedRoundTripper struct {
	mu       sync.Mutex
	steps    []scriptedStep
	requests []*http.Request
	bodies   [][]byte
}

type scriptedStep struct {
	status int
	body   string
	err    error
}

func (rt *scriptedRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.requests = append(rt.requests, request)
	rt.bodies = append(rt.bodies, append([]byte(nil), body...))
	index := len(rt.requests) - 1
	if index >= len(rt.steps) {
		return nil, errors.New("unexpected request")
	}
	step := rt.steps[index]
	if step.err != nil {
		return nil, step.err
	}
	return &http.Response{
		StatusCode: step.status,
		Body:       io.NopCloser(bytes.NewBufferString(step.body)),
		Header:     make(http.Header),
		Request:    request,
	}, nil
}

func (rt *scriptedRoundTripper) Calls() int {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return len(rt.requests)
}

func newScriptedClient(t *testing.T, roundTripper http.RoundTripper, options ...Option) *Client {
	t.Helper()
	options = append([]Option{WithBaseURL("https://ingest.example.test"), WithHTTPClient(&http.Client{Transport: roundTripper})}, options...)
	client, err := New("access-token", options...)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return client
}

func TestFullJitterBounds(t *testing.T) {
	for _, max := range []time.Duration{time.Nanosecond, 100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond, time.Second} {
		for range 1000 {
			if got := fullJitter(max); got < 0 || got > max {
				t.Errorf("fullJitter(%v) = %v, want value in [0, %v]", max, got, max)
			}
		}
	}
	if got := fullJitter(0); got != 0 {
		t.Errorf("fullJitter(0) = %v, want 0", got)
	}
}

func TestRetryMaximumSaturates(t *testing.T) {
	for _, test := range []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 1, want: 100 * time.Millisecond},
		{attempt: 2, want: 200 * time.Millisecond},
		{attempt: 3, want: 400 * time.Millisecond},
		{attempt: 4, want: 800 * time.Millisecond},
		{attempt: 5, want: time.Second},
		{attempt: 38, want: time.Second},
		{attempt: math.MaxInt, want: time.Second},
	} {
		if got := retryMaximum(test.attempt); got != test.want {
			t.Errorf("retryMaximum(%d) = %v, want %v", test.attempt, got, test.want)
		}
	}
}

func TestConfiguredRetryCountUsesSaturatedMaxima(t *testing.T) {
	roundTripper := &scriptedRoundTripper{steps: []scriptedStep{
		{status: http.StatusInternalServerError, body: `{"success":false,"error":"temporary"}`},
		{status: http.StatusInternalServerError, body: `{"success":false,"error":"temporary"}`},
		{status: http.StatusInternalServerError, body: `{"success":false,"error":"temporary"}`},
		{status: http.StatusInternalServerError, body: `{"success":false,"error":"temporary"}`},
		{status: http.StatusInternalServerError, body: `{"success":false,"error":"temporary"}`},
		{status: http.StatusInternalServerError, body: `{"success":false,"error":"final"}`},
	}}
	client := newScriptedClient(t, roundTripper, WithRetryCount(5))
	var maxima []time.Duration
	client.config.jitter = func(max time.Duration) time.Duration { maxima = append(maxima, max); return 0 }
	client.config.sleep = func(context.Context, time.Duration) error { return nil }

	_, err := client.OrderPaid(context.Background(), Event{Email: "ada@example.test"})
	var apiErr *ApiError
	if !errors.As(err, &apiErr) || apiErr.Attempts != 6 {
		t.Errorf("OrderPaid() error = %#v, want final *ApiError at attempt 6", err)
	}
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond, time.Second}
	if !slices.Equal(maxima, want) {
		t.Errorf("jitter maxima = %v, want %v", maxima, want)
	}
}

func TestRetryCountAttemptBounds(t *testing.T) {
	if _, err := New("access-token", WithRetryCount(math.MaxInt)); err == nil {
		t.Fatal("New() error = nil, want validation error for unrepresentable attempt count")
	} else {
		var validationErr *ValidationError
		if !errors.As(err, &validationErr) {
			t.Errorf("New() error = %T %v, want *ValidationError", err, err)
		}
	}

	if got, ok := retryAttempts(math.MaxInt - 1); !ok || got != math.MaxInt {
		t.Errorf("retryAttempts(math.MaxInt - 1) = (%d, %t), want (%d, true)", got, ok, math.MaxInt)
	}
	if _, ok := retryAttempts(math.MaxInt); ok {
		t.Error("retryAttempts(math.MaxInt) valid = true, want false")
	}
}

func TestRetry500AndTransportFailures(t *testing.T) {
	tests := []struct {
		name  string
		steps []scriptedStep
	}{
		{"five hundred then success", []scriptedStep{{status: http.StatusInternalServerError, body: `{"success":false,"error":"temporary"}`}, {status: http.StatusInternalServerError, body: `{"success":false,"error":"temporary"}`}, {status: http.StatusOK, body: canonicalSuccess}}},
		{"transport then success", []scriptedStep{{err: errors.New("disconnect")}, {err: errors.New("disconnect")}, {status: http.StatusOK, body: canonicalSuccess}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			roundTripper := &scriptedRoundTripper{steps: tt.steps}
			client := newScriptedClient(t, roundTripper)
			var maxima []time.Duration
			client.config.jitter = func(max time.Duration) time.Duration { maxima = append(maxima, max); return 0 }
			client.config.sleep = func(context.Context, time.Duration) error { return nil }

			ack, err := client.OrderPaid(context.Background(), Event{Email: "ada@example.test", Properties: map[string]any{"order": "one"}})
			if err != nil {
				t.Fatalf("OrderPaid() error = %v", err)
			}
			if ack.EventKey != "order_paid" {
				t.Errorf("acknowledgement key = %q, want order_paid", ack.EventKey)
			}
			if got := roundTripper.Calls(); got != 3 {
				t.Errorf("attempts = %d, want 3", got)
			}
			if len(maxima) != 2 || maxima[0] != 100*time.Millisecond || maxima[1] != 200*time.Millisecond {
				t.Errorf("jitter maxima = %v, want [100ms 200ms]", maxima)
			}
			if len(roundTripper.bodies) != 3 || !bytes.Equal(roundTripper.bodies[0], roundTripper.bodies[1]) || !bytes.Equal(roundTripper.bodies[1], roundTripper.bodies[2]) {
				t.Errorf("retry bodies = %q, want fresh equal payloads", roundTripper.bodies)
			}
			if roundTripper.requests[0] == roundTripper.requests[1] || roundTripper.requests[1] == roundTripper.requests[2] {
				t.Error("retry requests were reused instead of freshly constructed")
			}
		})
	}
}

func TestRetryPermanentStatusesAreNotRetried(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusNotFound, http.StatusTooManyRequests} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			roundTripper := &scriptedRoundTripper{steps: []scriptedStep{{status: status, body: `{"success":false,"error":"permanent"}`}}}
			client := newScriptedClient(t, roundTripper)
			client.config.sleep = func(context.Context, time.Duration) error { t.Fatal("sleep called for permanent status"); return nil }
			_, err := client.OrderPaid(context.Background(), Event{Email: "ada@example.test"})
			if err == nil {
				t.Fatal("OrderPaid() error = nil, want status error")
			}
			if got := roundTripper.Calls(); got != 1 {
				t.Errorf("attempts = %d, want 1", got)
			}
		})
	}
}

func TestRetryFinalFailureClassificationAndDefaultCap(t *testing.T) {
	t.Run("final five hundred is API error", func(t *testing.T) {
		roundTripper := &scriptedRoundTripper{steps: []scriptedStep{{err: errors.New("disconnect")}, {status: 500, body: `{"success":false,"error":"temporary"}`}, {status: 500, body: `{"success":false,"error":"final"}`}}}
		client := newScriptedClient(t, roundTripper)
		client.config.jitter = func(time.Duration) time.Duration { return 0 }
		client.config.sleep = func(context.Context, time.Duration) error { return nil }
		_, err := client.OrderPaid(context.Background(), Event{Email: "ada@example.test"})
		var apiErr *ApiError
		if !errors.As(err, &apiErr) || apiErr.Attempts != 3 {
			t.Errorf("error = %T %v, want final *ApiError at attempt 3", err, err)
		}
	})
	t.Run("final transport outcome is unknown", func(t *testing.T) {
		roundTripper := &scriptedRoundTripper{steps: []scriptedStep{{status: 500, body: `{"success":false,"error":"temporary"}`}, {err: errors.New("disconnect")}, {err: errors.New("final disconnect")}}}
		client := newScriptedClient(t, roundTripper)
		client.config.jitter = func(time.Duration) time.Duration { return 0 }
		client.config.sleep = func(context.Context, time.Duration) error { return nil }
		_, err := client.OrderPaid(context.Background(), Event{Email: "ada@example.test"})
		var transportErr *TransportError
		if !errors.As(err, &transportErr) || transportErr.Attempts != 3 || !transportErr.DeliveryOutcomeUnknown {
			t.Errorf("error = %#v, want final unknown *TransportError at attempt 3", err)
		}
	})
}

func TestCancellation(t *testing.T) {
	t.Run("before request", func(t *testing.T) {
		roundTripper := &scriptedRoundTripper{}
		client := newScriptedClient(t, roundTripper)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := client.OrderPaid(ctx, Event{Email: "ada@example.test"})
		if !errors.Is(err, context.Canceled) || roundTripper.Calls() != 0 {
			t.Errorf("OrderPaid() = %v with %d calls, want raw cancellation and zero calls", err, roundTripper.Calls())
		}
	})
	t.Run("during request", func(t *testing.T) {
		started := make(chan struct{})
		roundTripper := roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			close(started)
			<-request.Context().Done()
			return nil, request.Context().Err()
		})
		client := newScriptedClient(t, roundTripper, WithRetryCount(2))
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { _, err := client.OrderPaid(ctx, Event{Email: "ada@example.test"}); done <- err }()
		<-started
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Errorf("OrderPaid() error = %v, want raw context cancellation", err)
		}
	})
	t.Run("during backoff", func(t *testing.T) {
		roundTripper := &scriptedRoundTripper{steps: []scriptedStep{{status: 500, body: `{"success":false,"error":"temporary"}`}}}
		client := newScriptedClient(t, roundTripper)
		client.config.jitter = func(time.Duration) time.Duration { return time.Hour }
		started := make(chan struct{})
		client.config.sleep = func(ctx context.Context, _ time.Duration) error { close(started); <-ctx.Done(); return ctx.Err() }
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { _, err := client.OrderPaid(ctx, Event{Email: "ada@example.test"}); done <- err }()
		<-started
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) || roundTripper.Calls() != 1 {
			t.Errorf("OrderPaid() = %v with %d calls, want cancellation after one call", err, roundTripper.Calls())
		}
	})
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}
