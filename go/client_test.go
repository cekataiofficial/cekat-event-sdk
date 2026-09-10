package cekat

import (
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
		_, err := buildPayload("order_paid", true, event)
		var validationErr *ValidationError
		if !errors.As(err, &validationErr) {
			t.Fatalf("buildPayload() error = %T %v, want *ValidationError", err, err)
		}
	}
	if got := roundTripper.Calls(); got != 0 {
		t.Errorf("RoundTripper calls = %d, want 0", got)
	}
}
