package cekat

import "fmt"

// ValidationError reports invalid SDK configuration or event input.
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string {
	return e.Message
}

// AuthenticationError reports an HTTP 401 response.
type AuthenticationError struct {
	StatusCode int
	Message    string
	Code       string
	Body       []byte
	Attempts   int
}

func (e *AuthenticationError) Error() string {
	return formatStatusError(e.StatusCode, e.Message)
}

// EventDefinitionNotFoundError reports an HTTP 404 response.
type EventDefinitionNotFoundError struct {
	StatusCode int
	Message    string
	Code       string
	Body       []byte
	Attempts   int
}

func (e *EventDefinitionNotFoundError) Error() string {
	return formatStatusError(e.StatusCode, e.Message)
}

// ApiError reports a non-success HTTP response other than 401 or 404.
type ApiError struct {
	StatusCode int
	Message    string
	Code       string
	Body       []byte
	Attempts   int
}

func (e *ApiError) Error() string {
	return formatStatusError(e.StatusCode, e.Message)
}

// TransportError reports a request failure before a response is received.
type TransportError struct {
	Message                string
	Attempts               int
	DeliveryOutcomeUnknown bool
	Cause                  error
}

func (e *TransportError) Error() string {
	return e.Message
}

// Unwrap returns the underlying transport failure.
func (e *TransportError) Unwrap() error {
	return e.Cause
}

// ResponseDecodeError reports an invalid HTTP 200 response envelope.
type ResponseDecodeError struct {
	Message    string
	StatusCode int
	Body       []byte
	Attempts   int
	Cause      error
}

func (e *ResponseDecodeError) Error() string {
	return e.Message
}

// Unwrap returns the underlying response decoding failure.
func (e *ResponseDecodeError) Unwrap() error {
	return e.Cause
}

func formatStatusError(statusCode int, message string) string {
	if message == "" {
		return fmt.Sprintf("Cekat API request failed with status %d", statusCode)
	}
	return message
}
