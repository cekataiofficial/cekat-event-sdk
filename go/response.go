package cekat

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

const responseBodyLimit = 65_536

var errInvalidResponseEnvelope = errors.New("invalid response envelope")

// readBoundedBody retains at most responseBodyLimit bytes while observing one
// additional byte to determine whether the response exceeded that limit.
func readBoundedBody(reader io.Reader) (body []byte, overflow bool, err error) {
	observed, err := io.ReadAll(io.LimitReader(reader, responseBodyLimit+1))
	overflow = len(observed) > responseBodyLimit
	if overflow {
		observed = observed[:responseBodyLimit]
	}

	// ReadAll's backing buffer is intentionally not returned. This makes the
	// retained response body independent of temporary read storage.
	return append([]byte(nil), observed...), overflow, err
}

func decodeResponse(statusCode int, reader io.Reader, attempts int) (*Acknowledgement, error) {
	body, overflow, readErr := readBoundedBody(reader)
	if statusCode == http.StatusOK {
		if readErr != nil {
			return nil, responseDecodeError(body, attempts, readErr)
		}
		if overflow {
			return nil, responseDecodeError(body, attempts, errInvalidResponseEnvelope)
		}

		acknowledgement, err := decodeSuccessEnvelope(body)
		if err != nil {
			return nil, responseDecodeError(body, attempts, err)
		}
		acknowledgement.RawBody = body
		return acknowledgement, nil
	}

	message, code := decodeErrorEnvelope(body)
	if readErr != nil || message == "" {
		message = http.StatusText(statusCode)
		code = ""
	}
	return nil, newStatusError(statusCode, message, code, body, attempts)
}

func responseDecodeError(body []byte, attempts int, cause error) *ResponseDecodeError {
	return &ResponseDecodeError{
		Message:    "invalid response envelope",
		StatusCode: http.StatusOK,
		Body:       body,
		Attempts:   attempts,
		Cause:      cause,
	}
}

func newStatusError(statusCode int, message, code string, body []byte, attempts int) error {
	switch statusCode {
	case http.StatusUnauthorized:
		return &AuthenticationError{StatusCode: statusCode, Message: message, Code: code, Body: body, Attempts: attempts}
	case http.StatusNotFound:
		return &EventDefinitionNotFoundError{StatusCode: statusCode, Message: message, Code: code, Body: body, Attempts: attempts}
	default:
		return &APIError{StatusCode: statusCode, Message: message, Code: code, Body: body, Attempts: attempts}
	}
}

type successEnvelope struct {
	Success *bool           `json:"success"`
	Data    json.RawMessage `json:"data"`
}

type successData struct {
	Success             *bool              `json:"success"`
	Message             *string            `json:"message"`
	EventKey            *string            `json:"event_key"`
	ValidatedProperties *[]json.RawMessage `json:"validated_properties"`
}

func decodeSuccessEnvelope(body []byte) (*Acknowledgement, error) {
	var envelope successEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, err
	}
	if envelope.Success == nil || !*envelope.Success || !isJSONObject(envelope.Data) {
		return nil, errInvalidResponseEnvelope
	}

	var data successData
	if err := json.Unmarshal(envelope.Data, &data); err != nil {
		return nil, err
	}
	if data.Success == nil || !*data.Success || data.Message == nil || strings.TrimSpace(*data.Message) == "" || data.EventKey == nil || strings.TrimSpace(*data.EventKey) == "" || data.ValidatedProperties == nil {
		return nil, errInvalidResponseEnvelope
	}

	validatedProperties := make([]string, len(*data.ValidatedProperties))
	for index, property := range *data.ValidatedProperties {
		if string(property) == "null" {
			return nil, errInvalidResponseEnvelope
		}
		if err := json.Unmarshal(property, &validatedProperties[index]); err != nil {
			return nil, err
		}
	}

	return &Acknowledgement{
		Success:             true,
		Message:             *data.Message,
		EventKey:            *data.EventKey,
		ValidatedProperties: validatedProperties,
	}, nil
}

type errorEnvelope struct {
	Success *bool   `json:"success"`
	Error   *string `json:"error"`
	Code    *string `json:"code"`
}

func decodeErrorEnvelope(body []byte) (message, code string) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", ""
	}

	var envelope errorEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Success == nil || *envelope.Success || envelope.Error == nil || strings.TrimSpace(*envelope.Error) == "" {
		return "", ""
	}
	if rawCode, ok := raw["code"]; ok {
		if string(rawCode) == "null" || envelope.Code == nil {
			return "", ""
		}
		return *envelope.Error, *envelope.Code
	}
	return *envelope.Error, ""
}

func isJSONObject(value json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(value))
	return len(trimmed) > 1 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}
