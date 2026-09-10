package cekat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type countingRoundTripper struct {
	mu    sync.Mutex
	calls int
}

func (rt *countingRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.calls++
	return nil, errors.New("transport should not be called for invalid events")
}

func (rt *countingRoundTripper) Calls() int {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.calls
}

func TestPayloadVisitorPrecedence(t *testing.T) {
	tests := []struct {
		name     string
		explicit string
		context  string
		want     string
	}{
		{name: "trimmed explicit visitor takes precedence", explicit: "  event-visitor  ", context: "context-visitor", want: "event-visitor"},
		{name: "blank explicit visitor falls back to context", explicit: " \t ", context: "context-visitor", want: "context-visitor"},
		{name: "no visitor omits payload visitor", want: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := buildPayload(WithVisitorID(context.Background(), test.context), "order_paid", true, Event{
				Email:     "ada@example.test",
				VisitorID: test.explicit,
			})
			if err != nil {
				t.Fatalf("buildPayload() error = %v", err)
			}
			if payload.VisitorID != test.want {
				t.Errorf("payload.VisitorID = %q, want %q", payload.VisitorID, test.want)
			}
		})
	}
}

func TestBuildPayloadNilContextOmitsBlankVisitor(t *testing.T) {
	payload, err := buildPayload(nil, "order_paid", true, Event{
		Email:     "ada@example.test",
		VisitorID: " \t ",
	})
	if err != nil {
		t.Fatalf("buildPayload() error = %v", err)
	}
	if payload.VisitorID != "" {
		t.Errorf("payload.VisitorID = %q, want empty string", payload.VisitorID)
	}
}

func TestClientRequestInvalidInputPrecedesRoundTripper(t *testing.T) {
	roundTripper := &countingRoundTripper{}
	client, err := New("access-token", WithHTTPClient(&http.Client{Transport: roundTripper}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	for _, event := range []Event{{ContactName: "Ada"}, {Email: "ada@example.test", Properties: map[string]any{"secret": func() {}}}} {
		_, err := client.OrderPaid(context.Background(), event)
		var validationErr *ValidationError
		if !errors.As(err, &validationErr) {
			t.Fatalf("OrderPaid() error = %T %v, want *ValidationError", err, err)
		}
	}
	if got := roundTripper.Calls(); got != 0 {
		t.Errorf("RoundTripper calls = %d, want 0", got)
	}
}

func TestBuildPayloadValidationPrecedesRoundTripper(t *testing.T) {
	roundTripper := &countingRoundTripper{}
	client, err := New("access-token", WithHTTPClient(&http.Client{Transport: roundTripper}))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if client.config.httpClient.Transport != roundTripper {
		t.Fatal("client did not retain test RoundTripper")
	}

	invalidEvents := []Event{
		{ContactName: "Ada"},
		{Email: "ada@example.test", Properties: map[string]any{"secret": func() {}}},
	}
	for _, event := range invalidEvents {
		_, err := buildPayload(context.Background(), "order_paid", true, event)
		var validationErr *ValidationError
		if !errors.As(err, &validationErr) {
			t.Fatalf("buildPayload() error = %T %v, want *ValidationError", err, err)
		}
	}
	if got := roundTripper.Calls(); got != 0 {
		t.Errorf("RoundTripper calls = %d, want 0", got)
	}
}

type closingBody struct {
	io.Reader
	closed bool
}

func (body *closingBody) Close() error {
	body.closed = true
	return nil
}

func TestClientOperationsMapToExpectedPayload(t *testing.T) {
	tests := []struct {
		name     string
		invoke   func(*Client) (*Acknowledgement, error)
		wantKey  string
		isCommon bool
	}{
		{"user registration", func(c *Client) (*Acknowledgement, error) {
			return c.UserRegistration(context.Background(), Event{Email: "ada@example.test"})
		}, "user_registration", true},
		{"user login", func(c *Client) (*Acknowledgement, error) {
			return c.UserLogin(context.Background(), Event{Email: "ada@example.test"})
		}, "user_login", true},
		{"order created", func(c *Client) (*Acknowledgement, error) {
			return c.OrderCreated(context.Background(), Event{Email: "ada@example.test"})
		}, "order_created", true},
		{"order paid", func(c *Client) (*Acknowledgement, error) {
			return c.OrderPaid(context.Background(), Event{Email: "ada@example.test"})
		}, "order_paid", true},
		{"custom event", func(c *Client) (*Acknowledgement, error) {
			return c.CustomEvent(context.Background(), "trial_started", Event{Email: "ada@example.test"})
		}, "trial_started", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			roundTripper := roundTripperFunc(func(request *http.Request) (*http.Response, error) {
				var payload wirePayload
				if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
					t.Fatalf("decode request payload: %v", err)
				}
				if payload.EventKey != tt.wantKey || payload.IsCommon != tt.isCommon {
					t.Errorf("payload = %#v, want key %q and common %t", payload, tt.wantKey, tt.isCommon)
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(canonicalSuccess)), Header: make(http.Header), Request: request}, nil
			})
			if _, err := tt.invoke(newScriptedClient(t, roundTripper)); err != nil {
				t.Errorf("operation error = %v", err)
			}
		})
	}
}

func TestClientRequestConstructionAndResponseClose(t *testing.T) {
	var body *closingBody
	roundTripper := roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost || request.URL.String() != "https://ingest.example.test/api/events/ingest" {
			t.Errorf("request = %s %s, want POST fixed ingest endpoint", request.Method, request.URL)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer access-token" {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		if got := request.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		if deadline, ok := request.Context().Deadline(); !ok || time.Until(deadline) > 10*time.Second || time.Until(deadline) < 9*time.Second {
			t.Errorf("attempt deadline = %v (present %t), want approximately 10 seconds", deadline, ok)
		}
		body = &closingBody{Reader: strings.NewReader(canonicalSuccess)}
		return &http.Response{StatusCode: http.StatusOK, Body: body, Header: make(http.Header), Request: request}, nil
	})
	client := newScriptedClient(t, roundTripper)
	ack, err := client.OrderPaid(context.Background(), Event{Email: "ada@example.test"})
	if err != nil || ack == nil {
		t.Fatalf("OrderPaid() = %#v, %v", ack, err)
	}
	if !body.closed {
		t.Error("response body was not closed")
	}
}

func TestTimeoutUsesEarlierInjectedClientDeadlineWithoutMutation(t *testing.T) {
	injected := &http.Client{Timeout: 20 * time.Millisecond, Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}
	client, err := New("access-token", WithBaseURL("https://ingest.example.test"), WithHTTPClient(injected), WithRetryCount(0))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	started := time.Now()
	_, err = client.OrderPaid(context.Background(), Event{Email: "ada@example.test"})
	var transportErr *TransportError
	if !errors.As(err, &transportErr) || !transportErr.DeliveryOutcomeUnknown {
		t.Errorf("OrderPaid() error = %T %v, want unknown *TransportError", err, err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Errorf("injected client timeout did not apply promptly: %v", elapsed)
	}
	if injected.Timeout != 20*time.Millisecond {
		t.Errorf("injected client timeout = %v, want unchanged 20ms", injected.Timeout)
	}
}

func TestClientConcurrent(t *testing.T) {
	client := newScriptedClient(t, roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(canonicalSuccess)), Header: make(http.Header), Request: request}, nil
	}))
	const workers = 32
	errors := make(chan error, workers)
	var waitGroup sync.WaitGroup
	for index := 0; index < workers; index++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			_, err := client.OrderPaid(context.Background(), Event{Email: "ada@example.test", Properties: map[string]any{"nested": []any{"value"}}})
			errors <- err
		}()
	}
	waitGroup.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Errorf("concurrent OrderPaid() error = %v", err)
		}
	}
}
