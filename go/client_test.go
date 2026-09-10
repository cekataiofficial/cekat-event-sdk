package cekat

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
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
