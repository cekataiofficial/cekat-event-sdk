package cekat

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestNewUsesDocumentedDefaults(t *testing.T) {
	client, err := New("access-token")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	if got, want := client.config.baseURL, "https://server.cekat.ai"; got != want {
		t.Errorf("baseURL = %q, want %q", got, want)
	}
	if got, want := client.config.timeout, 10*time.Second; got != want {
		t.Errorf("timeout = %s, want %s", got, want)
	}
	if got, want := client.config.retryCount, 2; got != want {
		t.Errorf("retryCount = %d, want %d", got, want)
	}
	if client.config.httpClient == nil {
		t.Error("httpClient is nil")
	}
}

func TestNewRejectsInvalidConfiguration(t *testing.T) {
	const token = "secret-access-token"

	tests := []struct {
		name   string
		token  string
		option Option
	}{
		{name: "blank token", token: " \t\n "},
		{name: "relative URL", token: token, option: WithBaseURL("/relative")},
		{name: "non HTTP URL", token: token, option: WithBaseURL("ftp://example.test")},
		{name: "missing URL host", token: token, option: WithBaseURL("https:")},
		{name: "port-only URL authority", token: token, option: WithBaseURL("https://:443")},
		{name: "URL credentials", token: token, option: WithBaseURL("https://user:password@example.test")},
		{name: "URL path", token: token, option: WithBaseURL("https://example.test/not-an-origin")},
		{name: "URL query", token: token, option: WithBaseURL("https://example.test?query=value")},
		{name: "URL empty query", token: token, option: WithBaseURL("https://example.test?")},
		{name: "URL fragment", token: token, option: WithBaseURL("https://example.test#fragment")},
		{name: "zero timeout", token: token, option: WithTimeout(0)},
		{name: "negative timeout", token: token, option: WithTimeout(-time.Second)},
		{name: "negative retries", token: token, option: WithRetryCount(-1)},
		{name: "nil HTTP client", token: token, option: WithHTTPClient(nil)},
		{name: "ordinary option error", token: token, option: func(*config) error { return errors.New("invalid setting") }},
		{name: "invalid final config", token: token, option: func(cfg *config) error {
			cfg.baseURL = "mailto:invalid@example.test"
			return nil
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			options := []Option(nil)
			if tt.option != nil {
				options = []Option{tt.option}
			}

			client, err := New(tt.token, options...)
			if client != nil {
				t.Fatalf("New() client = %#v, want nil", client)
			}
			if err == nil {
				t.Fatal("New() error = nil, want validation error")
			}

			var validationErr *ValidationError
			if !errors.As(err, &validationErr) {
				t.Fatalf("New() error type = %T, want *ValidationError", err)
			}
			if strings.Contains(err.Error(), token) {
				t.Fatalf("New() error leaked access token: %q", err)
			}
		})
	}
}

func TestOptionsNormalizeTrailingSlashAndRetainHTTPClient(t *testing.T) {
	httpClient := &http.Client{Timeout: time.Second}
	client, err := New("access-token",
		WithBaseURL("https://example.test/"),
		WithTimeout(3*time.Second),
		WithRetryCount(4),
		WithHTTPClient(httpClient),
	)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if got, want := client.config.baseURL, "https://example.test"; got != want {
		t.Errorf("baseURL = %q, want %q", got, want)
	}
	if got := client.config.httpClient; got != httpClient {
		t.Errorf("httpClient = %p, want injected client %p", got, httpClient)
	}
	if got, want := httpClient.Timeout, time.Second; got != want {
		t.Errorf("injected client timeout = %s, want %s", got, want)
	}
}
