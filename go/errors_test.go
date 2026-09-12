package cekat

import (
	"errors"
	"fmt"
	"testing"
)

func TestTypedErrorsMatchWithErrorsAs(t *testing.T) {
	cause := errors.New("network failed")
	body := []byte("response body")

	tests := []struct {
		name       string
		err        error
		assertType func(*testing.T, error)
		unwrap     error
	}{
		{
			name: "validation",
			err:  &ValidationError{Message: "invalid event"},
			assertType: func(t *testing.T, err error) {
				t.Helper()
				var typed *ValidationError
				if !errors.As(err, &typed) || typed.Message != "invalid event" {
					t.Fatalf("errors.As() = %#v, want validation error", typed)
				}
			},
		},
		{
			name: "authentication",
			err:  &AuthenticationError{StatusCode: 401, Message: "unauthorized", Code: "bad_token", Body: body, Attempts: 1},
			assertType: func(t *testing.T, err error) {
				t.Helper()
				var typed *AuthenticationError
				if !errors.As(err, &typed) || typed.StatusCode != 401 || typed.Message != "unauthorized" || typed.Code != "bad_token" || typed.Attempts != 1 {
					t.Fatalf("errors.As() = %#v, want authentication error fields", typed)
				}
			},
		},
		{
			name: "event definition not found",
			err:  &EventDefinitionNotFoundError{StatusCode: 404, Message: "missing", Code: "unknown_event", Body: body, Attempts: 2},
			assertType: func(t *testing.T, err error) {
				t.Helper()
				var typed *EventDefinitionNotFoundError
				if !errors.As(err, &typed) || typed.StatusCode != 404 || typed.Message != "missing" || typed.Code != "unknown_event" || typed.Attempts != 2 {
					t.Fatalf("errors.As() = %#v, want event definition error fields", typed)
				}
			},
		},
		{
			name: "API",
			err:  &ApiError{StatusCode: 500, Message: "server failed", Code: "server_error", Body: body, Attempts: 3},
			assertType: func(t *testing.T, err error) {
				t.Helper()
				var typed *ApiError
				if !errors.As(err, &typed) || typed.StatusCode != 500 || typed.Message != "server failed" || typed.Code != "server_error" || typed.Attempts != 3 {
					t.Fatalf("errors.As() = %#v, want API error fields", typed)
				}
			},
		},
		{
			name:   "transport",
			err:    &TransportError{Message: "request failed", Attempts: 2, DeliveryOutcomeUnknown: true, Cause: cause},
			unwrap: cause,
			assertType: func(t *testing.T, err error) {
				t.Helper()
				var typed *TransportError
				if !errors.As(err, &typed) || typed.Message != "request failed" || typed.Attempts != 2 || !typed.DeliveryOutcomeUnknown {
					t.Fatalf("errors.As() = %#v, want transport error fields", typed)
				}
			},
		},
		{
			name:   "response decode",
			err:    &ResponseDecodeError{Message: "invalid response", StatusCode: 200, Body: body, Attempts: 1, Cause: cause},
			unwrap: cause,
			assertType: func(t *testing.T, err error) {
				t.Helper()
				var typed *ResponseDecodeError
				if !errors.As(err, &typed) || typed.Message != "invalid response" || typed.StatusCode != 200 || typed.Attempts != 1 {
					t.Fatalf("errors.As() = %#v, want decode error fields", typed)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wrapped := fmt.Errorf("operation: %w", tt.err)
			tt.assertType(t, wrapped)
			if tt.unwrap != nil && !errors.Is(tt.err, tt.unwrap) {
				t.Fatalf("errors.Is(%v, %v) = false, want true", tt.err, tt.unwrap)
			}
		})
	}
}

func TestTypedErrorsRetainResponseBodies(t *testing.T) {
	body := []byte("response body")
	errorsWithBody := []struct {
		name string
		body []byte
	}{
		{name: "authentication", body: (&AuthenticationError{Body: body}).Body},
		{name: "event definition not found", body: (&EventDefinitionNotFoundError{Body: body}).Body},
		{name: "API", body: (&ApiError{Body: body}).Body},
		{name: "response decode", body: (&ResponseDecodeError{Body: body}).Body},
	}

	for _, tt := range errorsWithBody {
		t.Run(tt.name, func(t *testing.T) {
			if got, want := string(tt.body), "response body"; got != want {
				t.Errorf("body = %q, want %q", got, want)
			}
		})
	}
}
