package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	cekat "github.com/cekataiofficial/cekat-event-sdk-go"
)

func TestSharedConformance(t *testing.T) {
	baseURL := requiredEnvironment(t, "CEKAT_CONFORMANCE_BASE_URL")
	controlURL := requiredEnvironment(t, "CEKAT_CONFORMANCE_CONTROL_URL")
	token := requiredEnvironment(t, "CEKAT_CONFORMANCE_ACCESS_TOKEN")
	fixtures, err := loadFixtures(requiredEnvironment(t, "CEKAT_CONFORMANCE_FIXTURES"))
	if err != nil {
		t.Fatal(err)
	}
	control := newControlClient(controlURL)
	executed := make(map[string]struct{}, len(fixtures))
	for _, f := range fixtures {
		f := f
		t.Run(f.ID, func(t *testing.T) {
			if err := control.reset(); err != nil {
				t.Fatal(err)
			}
			if err := control.queue(f.Responses, f.BodyRecipe); err != nil {
				t.Fatal(err)
			}
			runFixture(t, f, baseURL, token, control)
			executed[f.ID] = struct{}{}
			fmt.Printf("{\"id\":%q,\"status\":\"passed\"}\n", f.ID)
		})
	}
	if len(executed) != len(fixtures) {
		t.Fatalf("executed %d of %d discovered fixtures", len(executed), len(fixtures))
	}
	for _, f := range fixtures {
		if _, ok := executed[f.ID]; !ok {
			t.Fatalf("required case %q was not executed", f.ID)
		}
	}
}

func requiredEnvironment(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%s is required", name)
	}
	return value
}

func runFixture(t *testing.T, f fixture, baseURL, token string, control *controlClient) {
	t.Helper()
	ctx := context.Background()
	if f.Inbound.AmbientVisitorID != nil {
		ctx = cekat.WithVisitorID(ctx, *f.Inbound.AmbientVisitorID)
	}
	if f.Inbound.HeaderVisitorID != nil || f.Inbound.CookieVisitorID != nil {
		req, err := http.NewRequest(http.MethodGet, "http://conformance.invalid", nil)
		if err != nil {
			t.Fatal(err)
		}
		if f.Inbound.HeaderVisitorID != nil {
			req.Header.Set("X-Cekat-Visitor-ID", *f.Inbound.HeaderVisitorID)
		}
		if f.Inbound.CookieVisitorID != nil {
			req.AddCookie(&http.Cookie{Name: "_cekat_visitor_id", Value: *f.Inbound.CookieVisitorID})
		}
		ctx = cekat.WithVisitorFromRequest(req.WithContext(ctx)).Context()
	}
	options := []cekat.Option{cekat.WithBaseURL(baseURL)}
	if f.Client.TimeoutMS != nil {
		options = append(options, cekat.WithTimeout(time.Duration(*f.Client.TimeoutMS)*time.Millisecond))
	}
	if f.Client.RetryCount != nil {
		options = append(options, cekat.WithRetryCount(*f.Client.RetryCount))
	}
	var cancel context.CancelFunc
	if f.Cancellation != nil {
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		if f.Cancellation.Phase == "before_request" {
			cancel()
		}
		if f.Cancellation.Phase == "during_backoff" {
			options = append(options, cekat.WithHTTPClient(&http.Client{Transport: cancelOnFirst500{next: http.DefaultTransport, cancel: cancel}}))
		}
	}
	client, err := cekat.New(token, options...)
	if err != nil {
		t.Fatalf("construct public client: %v", err)
	}
	event := cekat.Event{Properties: f.Operation.Event.Properties}
	if f.Operation.Event.Email != nil {
		event.Email = *f.Operation.Event.Email
	}
	if f.Operation.Event.PhoneNumber != nil {
		event.PhoneNumber = *f.Operation.Event.PhoneNumber
	}
	if f.Operation.Event.ContactName != nil {
		event.ContactName = *f.Operation.Event.ContactName
	}
	if f.Operation.Event.VisitorID != nil {
		event.VisitorID = *f.Operation.Event.VisitorID
	}
	if f.Operation.PropertiesRecipe != nil {
		event.Properties = recipeProperties(*f.Operation.PropertiesRecipe)
	}
	if f.Cancellation != nil && f.Cancellation.Phase == "during_request" {
		go cancelWhenJournaled(control, cancel)
	}
	ack, gotErr := dispatch(client, ctx, f.Operation, event)
	assertResult(t, f, ack, gotErr)
	requests, err := control.requests()
	if err != nil {
		t.Fatal(err)
	}
	assertJournal(t, f, requests)
}

type cancelOnFirst500 struct {
	next   http.RoundTripper
	cancel context.CancelFunc
}

func (r cancelOnFirst500) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := r.next.RoundTrip(request)
	if err == nil && response.StatusCode == http.StatusInternalServerError {
		r.cancel()
	}
	return response, err
}
func cancelWhenJournaled(control *controlClient, cancel context.CancelFunc) {
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		requests, err := control.requests()
		if err == nil && len(requests) > 0 {
			cancel()
			return
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
}

func dispatch(client *cekat.Client, ctx context.Context, operation operation, event cekat.Event) (*cekat.Acknowledgement, error) {
	switch operation.Name {
	case "user_registration":
		return client.UserRegistration(ctx, event)
	case "user_login":
		return client.UserLogin(ctx, event)
	case "order_created":
		return client.OrderCreated(ctx, event)
	case "order_paid":
		return client.OrderPaid(ctx, event)
	case "custom_event":
		if operation.EventKey == nil {
			return nil, fmt.Errorf("custom_event requires event_key")
		}
		return client.CustomEvent(ctx, *operation.EventKey, event)
	default:
		return nil, fmt.Errorf("unknown operation %q", operation.Name)
	}
}

func assertResult(t *testing.T, f fixture, ack *cekat.Acknowledgement, err error) {
	t.Helper()
	if f.Expect.Result == "acknowledgement" {
		if err != nil {
			t.Fatalf("expected acknowledgement, got %T: %v", err, err)
		}
		if ack == nil {
			t.Fatal("missing acknowledgement")
		}
		if f.Expect.Acknowledgement == nil {
			return
		}
		expected := f.Expect.Acknowledgement
		if ack.Success != expected.Success || ack.Message != expected.Message || ack.EventKey != expected.EventKey || !reflect.DeepEqual(ack.ValidatedProperties, expected.ValidatedProperties) {
			t.Fatalf("acknowledgement = %#v, want %#v", ack, expected)
		}
		return
	}
	if err == nil {
		t.Fatalf("expected %s error, got acknowledgement %#v", f.Expect.Result, ack)
	}
	if f.Expect.Result == "caller_cancelled" {
		if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("caller cancellation = %T %v", err, err)
		}
		switch err.(type) {
		case *cekat.ValidationError, *cekat.TransportError, *cekat.ResponseDecodeError, *cekat.ApiError, *cekat.AuthenticationError, *cekat.EventDefinitionNotFoundError:
			t.Fatalf("caller cancellation wrapped by SDK error: %T", err)
		}
		return
	}
	if f.Expect.Result == "validation_error" {
		if _, ok := err.(*cekat.ValidationError); !ok {
			t.Fatalf("error type = %T, want ValidationError", err)
		}
		return
	}
	if f.Expect.Result == "transport_error" {
		value, ok := err.(*cekat.TransportError)
		if !ok {
			t.Fatalf("error type = %T, want TransportError", err)
		}
		assertAttempts(t, f, value.Attempts)
		assertDelivery(t, f, value.DeliveryOutcomeUnknown)
		return
	}
	if f.Expect.Result == "response_decode_error" {
		value, ok := err.(*cekat.ResponseDecodeError)
		if !ok {
			t.Fatalf("error type = %T, want ResponseDecodeError", err)
		}
		assertAttempts(t, f, value.Attempts)
		assertBody(t, f, value.Body)
		return
	}
	var status int
	var message, serverError, serverCode string
	var attempts int
	var body []byte
	switch value := err.(type) {
	case *cekat.ApiError:
		status, message, serverError, serverCode, attempts, body = value.StatusCode, value.Message, value.Message, value.Code, value.Attempts, value.Body
		if f.Expect.Result != "api_error" {
			t.Fatalf("error type = ApiError, want %s", f.Expect.Result)
		}
	case *cekat.AuthenticationError:
		status, message, serverError, serverCode, attempts, body = value.StatusCode, value.Message, value.Message, value.Code, value.Attempts, value.Body
		if f.Expect.Result != "authentication_error" {
			t.Fatalf("error type = AuthenticationError, want %s", f.Expect.Result)
		}
	case *cekat.EventDefinitionNotFoundError:
		status, message, serverError, serverCode, attempts, body = value.StatusCode, value.Message, value.Message, value.Code, value.Attempts, value.Body
		if f.Expect.Result != "event_definition_not_found_error" {
			t.Fatalf("error type = EventDefinitionNotFoundError, want %s", f.Expect.Result)
		}
	default:
		t.Fatalf("error type = %T, want %s", err, f.Expect.Result)
	}
	if f.Expect.Status != nil && status != *f.Expect.Status {
		t.Fatalf("status = %d, want %d", status, *f.Expect.Status)
	}
	if f.Expect.ErrorMessage != nil && message != *f.Expect.ErrorMessage {
		t.Fatalf("message = %q, want %q", message, *f.Expect.ErrorMessage)
	}
	if f.Expect.ServerError != nil && serverError != *f.Expect.ServerError {
		t.Fatalf("server error = %q, want %q", serverError, *f.Expect.ServerError)
	}
	if f.Expect.ServerCode != nil && serverCode != *f.Expect.ServerCode {
		t.Fatalf("server code = %q, want %q", serverCode, *f.Expect.ServerCode)
	}
	assertAttempts(t, f, attempts)
	assertBody(t, f, body)
}
func assertAttempts(t *testing.T, f fixture, actual int) {
	t.Helper()
	if actual != f.Expect.Attempts {
		t.Fatalf("attempts = %d, want %d", actual, f.Expect.Attempts)
	}
}
func assertDelivery(t *testing.T, f fixture, actual bool) {
	t.Helper()
	if f.Expect.DeliveryUnknown != nil && actual != *f.Expect.DeliveryUnknown {
		t.Fatalf("delivery outcome unknown = %t, want %t", actual, *f.Expect.DeliveryUnknown)
	}
}
func assertBody(t *testing.T, f fixture, body []byte) {
	t.Helper()
	if f.Expect.RetainedBodyBytes != nil && len(body) != *f.Expect.RetainedBodyBytes {
		t.Fatalf("retained body bytes = %d, want %d", len(body), *f.Expect.RetainedBodyBytes)
	}
	if f.BodyRecipe != nil && f.Expect.BodyTruncated != nil && *f.Expect.BodyTruncated && !strings.Contains(strings.ToValidUTF8(string(body), "\uFFFD"), "\uFFFD") {
		t.Fatalf("truncated text body does not include replacement character")
	}
}
func assertJournal(t *testing.T, f fixture, requests []journalEntry) {
	t.Helper()
	if len(requests) != f.Expect.Attempts {
		t.Fatalf("journal length = %d, want %d", len(requests), f.Expect.Attempts)
	}
	if f.Expect.Request == nil {
		return
	}
	var expected any
	if err := json.Unmarshal(f.Expect.Request.Payload, &expected); err != nil {
		t.Fatal(err)
	}
	for index, request := range requests {
		if request.Sequence != index+1 || request.Method != http.MethodPost || request.Path != f.Expect.Request.Path {
			t.Fatalf("journal[%d] = %#v", index, request)
		}
		if values := request.Headers["authorization"]; !reflect.DeepEqual(values, []string{f.Expect.Request.Authorization}) {
			t.Fatalf("journal[%d] authorization = %#v", index, values)
		}
		var actual any
		if err := json.Unmarshal([]byte(request.Body), &actual); err != nil {
			t.Fatalf("journal[%d] JSON: %v", index, err)
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("journal[%d] payload = %#v, want %#v", index, actual, expected)
		}
	}
}
