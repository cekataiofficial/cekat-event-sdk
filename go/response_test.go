package cekat

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

const canonicalSuccess = `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}`

func TestReadBoundedBody(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		want     string
		observed int
	}{
		{name: "short body", input: "body", want: "body", observed: 4},
		{name: "exact limit", input: strings.Repeat("a", responseBodyLimit), want: strings.Repeat("a", responseBodyLimit), observed: responseBodyLimit},
		{name: "over limit", input: strings.Repeat("a", responseBodyLimit+20), want: strings.Repeat("a", responseBodyLimit), observed: responseBodyLimit + 1},
		{name: "multibyte boundary", input: strings.Repeat("€", responseBodyLimit/3+1), want: strings.Repeat("€", responseBodyLimit/3) + "€"[:1], observed: responseBodyLimit + 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reader := &observingReader{Reader: strings.NewReader(tt.input)}
			got, err := readBoundedBody(reader)
			if err != nil {
				t.Fatalf("readBoundedBody() error = %v", err)
			}
			if string(got) != tt.want {
				t.Errorf("readBoundedBody() = %q, want %q", got, tt.want)
			}
			if reader.read != tt.observed {
				t.Errorf("observed bytes = %d, want %d", reader.read, tt.observed)
			}
		})
	}

	input := []byte("body")
	got, err := readBoundedBody(bytes.NewReader(input))
	if err != nil {
		t.Fatalf("readBoundedBody() error = %v", err)
	}
	input[0] = 'x'
	if string(got) != "body" {
		t.Errorf("readBoundedBody() retained %q after source mutation, want owned body", got)
	}
}

type observingReader struct {
	io.Reader
	read int
}

func (r *observingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.read += n
	return n, err
}

func TestDecodeResponseSuccess(t *testing.T) {
	body := canonicalSuccess[:len(canonicalSuccess)-1] + `,"unknown":"ignored"}`
	ack, err := decodeResponse(http.StatusOK, strings.NewReader(body), 2)
	if err != nil {
		t.Fatalf("decodeResponse() error = %v", err)
	}
	if ack == nil {
		t.Fatal("decodeResponse() acknowledgement = nil")
	}
	if !ack.Success || ack.Message != "accepted" || ack.EventKey != "order_paid" {
		t.Errorf("acknowledgement = %#v, want canonical fields", ack)
	}
	if len(ack.ValidatedProperties) != 1 || ack.ValidatedProperties[0] != "order_id" {
		t.Errorf("ValidatedProperties = %#v, want [order_id]", ack.ValidatedProperties)
	}
	if string(ack.RawBody) != body {
		t.Errorf("RawBody = %q, want %q", ack.RawBody, body)
	}
}

func TestDecodeResponseRejectsMalformed200(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "malformed JSON", body: `{"success":true`},
		{name: "outer success missing", body: `{"data":{}}`},
		{name: "outer success false", body: `{"success":false,"data":{}}`},
		{name: "outer success wrong type", body: `{"success":"true","data":{}}`},
		{name: "data missing", body: `{"success":true}`},
		{name: "data wrong type", body: `{"success":true,"data":false}`},
		{name: "inner success missing", body: `{"success":true,"data":{"message":"accepted","event_key":"order_paid","validated_properties":[]}}`},
		{name: "inner success false", body: `{"success":true,"data":{"success":false,"message":"accepted","event_key":"order_paid","validated_properties":[]}}`},
		{name: "inner success wrong type", body: `{"success":true,"data":{"success":"true","message":"accepted","event_key":"order_paid","validated_properties":[]}}`},
		{name: "message missing", body: `{"success":true,"data":{"success":true,"event_key":"order_paid","validated_properties":[]}}`},
		{name: "message blank", body: `{"success":true,"data":{"success":true,"message":" \t","event_key":"order_paid","validated_properties":[]}}`},
		{name: "message wrong type", body: `{"success":true,"data":{"success":true,"message":false,"event_key":"order_paid","validated_properties":[]}}`},
		{name: "event key missing", body: `{"success":true,"data":{"success":true,"message":"accepted","validated_properties":[]}}`},
		{name: "event key blank", body: `{"success":true,"data":{"success":true,"message":"accepted","event_key":" ","validated_properties":[]}}`},
		{name: "event key wrong type", body: `{"success":true,"data":{"success":true,"message":"accepted","event_key":false,"validated_properties":[]}}`},
		{name: "validated properties missing", body: `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid"}}`},
		{name: "validated properties object", body: `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":{}}}`},
		{name: "validated property non-string", body: `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":[false]}}`},
		{name: "validated property null", body: `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":[null]}}`},
		{name: "validated properties null", body: `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":null}}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ack, err := decodeResponse(http.StatusOK, strings.NewReader(tt.body), 3)
			if ack != nil {
				t.Errorf("decodeResponse() acknowledgement = %#v, want nil", ack)
			}
			var decodeErr *ResponseDecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("decodeResponse() error = %T %v, want *ResponseDecodeError", err, err)
			}
			if decodeErr.StatusCode != http.StatusOK || decodeErr.Attempts != 3 || string(decodeErr.Body) != tt.body || decodeErr.Cause == nil {
				t.Errorf("decode error = %#v, want status, attempts, body, and cause", decodeErr)
			}
		})
	}
}

func TestDecodeResponseMapsNonSuccessStatuses(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		attempts   int
		assert     func(*testing.T, error)
	}{
		{
			name: "structured 400", statusCode: http.StatusBadRequest, attempts: 1,
			body: `{"success":false,"error":"bad event","code":"bad_event"}`,
			assert: func(t *testing.T, err error) {
				var api *ApiError
				if !errors.As(err, &api) || api.Message != "bad event" || api.Code != "bad_event" {
					t.Fatalf("error = %#v, want structured *ApiError", api)
				}
			},
		},
		{
			name: "structured 401", statusCode: http.StatusUnauthorized, attempts: 2,
			body: `{"success":false,"error":"bad token","code":"unauthorized"}`,
			assert: func(t *testing.T, err error) {
				var auth *AuthenticationError
				if !errors.As(err, &auth) || auth.Message != "bad token" || auth.Code != "unauthorized" {
					t.Fatalf("error = %#v, want structured *AuthenticationError", auth)
				}
			},
		},
		{
			name: "structured 404", statusCode: http.StatusNotFound, attempts: 3,
			body: `{"success":false,"error":"unknown event","code":"unknown_event"}`,
			assert: func(t *testing.T, err error) {
				var missing *EventDefinitionNotFoundError
				if !errors.As(err, &missing) || missing.Message != "unknown event" || missing.Code != "unknown_event" {
					t.Fatalf("error = %#v, want structured *EventDefinitionNotFoundError", missing)
				}
			},
		},
		{
			name: "structured 500", statusCode: http.StatusInternalServerError, attempts: 4,
			body: `{"success":false,"error":"retry exhausted"}`,
			assert: func(t *testing.T, err error) {
				var api *ApiError
				if !errors.As(err, &api) || api.Message != "retry exhausted" || api.Code != "" {
					t.Fatalf("error = %#v, want *ApiError with absent code", api)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ack, err := decodeResponse(tt.statusCode, strings.NewReader(tt.body), tt.attempts)
			if ack != nil {
				t.Errorf("decodeResponse() acknowledgement = %#v, want nil", ack)
			}
			if err == nil {
				t.Fatal("decodeResponse() error = nil")
			}
			tt.assert(t, err)
			assertStatusErrorFields(t, err, tt.statusCode, tt.attempts, tt.body)
		})
	}
}

func TestDecodeResponseMalformedNonSuccessUsesStatusText(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		statusCode int
	}{
		{name: "malformed JSON", statusCode: http.StatusTeapot, body: `not JSON`},
		{name: "outer success true", statusCode: http.StatusBadRequest, body: `{"success":true,"error":"not accepted"}`},
		{name: "missing error", statusCode: http.StatusBadRequest, body: `{"success":false}`},
		{name: "blank error", statusCode: http.StatusBadRequest, body: `{"success":false,"error":" \t"}`},
		{name: "error wrong type", statusCode: http.StatusBadRequest, body: `{"success":false,"error":false}`},
		{name: "invalid code", statusCode: http.StatusBadRequest, body: `{"success":false,"error":"bad event","code":false}`},
		{name: "null code", statusCode: http.StatusBadRequest, body: `{"success":false,"error":"bad event","code":null}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := decodeResponse(tt.statusCode, strings.NewReader(tt.body), 2)
			var api *ApiError
			if !errors.As(err, &api) {
				t.Fatalf("decodeResponse() error = %T %v, want *ApiError", err, err)
			}
			if api.Message != http.StatusText(tt.statusCode) || api.Code != "" {
				t.Errorf("ApiError = %#v, want fallback status text and blank code", api)
			}
			assertStatusErrorFields(t, err, tt.statusCode, 2, tt.body)
		})
	}
}

func TestDecodeResponseRetainsBoundedMultibyteBody(t *testing.T) {
	body := strings.Repeat("€", responseBodyLimit/3+1) + "END"
	want := []byte(body)[:responseBodyLimit]

	_, err := decodeResponse(http.StatusOK, strings.NewReader(body), 1)
	var decodeErr *ResponseDecodeError
	if !errors.As(err, &decodeErr) {
		t.Fatalf("decodeResponse(200) error = %T %v, want *ResponseDecodeError", err, err)
	}
	if len(decodeErr.Body) != responseBodyLimit || !bytes.Equal(decodeErr.Body, want) {
		t.Errorf("decode body = %d bytes %q, want first %d bytes", len(decodeErr.Body), decodeErr.Body, responseBodyLimit)
	}

	_, err = decodeResponse(http.StatusBadRequest, strings.NewReader(body), 1)
	var api *ApiError
	if !errors.As(err, &api) {
		t.Fatalf("decodeResponse(400) error = %T %v, want *ApiError", err, err)
	}
	if api.Message != http.StatusText(http.StatusBadRequest) || len(api.Body) != responseBodyLimit || !bytes.Equal(api.Body, want) {
		t.Errorf("ApiError = %#v, want bounded body and fallback status text", api)
	}
}

func assertStatusErrorFields(t *testing.T, err error, statusCode, attempts int, body string) {
	t.Helper()
	switch typed := err.(type) {
	case *AuthenticationError:
		if typed.StatusCode != statusCode || typed.Attempts != attempts || string(typed.Body) != body {
			t.Errorf("AuthenticationError = %#v, want status, attempts, and body", typed)
		}
	case *EventDefinitionNotFoundError:
		if typed.StatusCode != statusCode || typed.Attempts != attempts || string(typed.Body) != body {
			t.Errorf("EventDefinitionNotFoundError = %#v, want status, attempts, and body", typed)
		}
	case *ApiError:
		if typed.StatusCode != statusCode || typed.Attempts != attempts || string(typed.Body) != body {
			t.Errorf("ApiError = %#v, want status, attempts, and body", typed)
		}
	default:
		t.Errorf("error = %T, want status error", err)
	}
}
