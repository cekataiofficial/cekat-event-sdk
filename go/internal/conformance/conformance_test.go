package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	cekat "golang.cekat.ai/event-sdk"
	"golang.cekat.ai/event-sdk/internal/retryobserver"
)

func TestSharedConformance(t *testing.T) {
	if conformanceEnvironmentAbsent() {
		t.Skip("shared conformance environment is not configured")
	}
	requireConformanceEnvironment(t)
	baseURL := requiredEnvironment(t, "CEKAT_CONFORMANCE_BASE_URL")
	controlURL := requiredEnvironment(t, "CEKAT_CONFORMANCE_CONTROL_URL")
	if _, err := absoluteHTTPOrigin(baseURL); err != nil {
		t.Fatalf("invalid CEKAT_CONFORMANCE_BASE_URL: %v", err)
	}
	token := requiredEnvironment(t, "CEKAT_CONFORMANCE_ACCESS_TOKEN")
	fixtures, err := loadFixtures(requiredEnvironment(t, "CEKAT_CONFORMANCE_FIXTURES"))
	if err != nil {
		t.Fatal(err)
	}
	control, err := newControlClient(controlURL)
	if err != nil {
		t.Fatal(err)
	}
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

func conformanceEnvironmentAbsent() bool {
	for _, name := range []string{"CEKAT_CONFORMANCE_BASE_URL", "CEKAT_CONFORMANCE_CONTROL_URL", "CEKAT_CONFORMANCE_ACCESS_TOKEN", "CEKAT_CONFORMANCE_FIXTURES"} {
		if os.Getenv(name) != "" {
			return false
		}
	}
	return true
}

func requiredEnvironment(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%s is required", name)
	}
	return value
}

func requireConformanceEnvironment(t *testing.T) {
	t.Helper()
	allowed := map[string]struct{}{
		"CEKAT_CONFORMANCE_BASE_URL": {}, "CEKAT_CONFORMANCE_CONTROL_URL": {},
		"CEKAT_CONFORMANCE_ACCESS_TOKEN": {}, "CEKAT_CONFORMANCE_FIXTURES": {},
	}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "CEKAT_CONFORMANCE_") {
			if _, ok := allowed[name]; !ok {
				t.Fatalf("unrecognized conformance environment variable %s", name)
			}
		}
	}
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
	if f.Operation.Event.EventID != nil {
		event.EventID = *f.Operation.Event.EventID
	}
	if f.Operation.Event.OccurredAt != nil {
		occurredAt, err := time.Parse(time.RFC3339Nano, *f.Operation.Event.OccurredAt)
		if err != nil {
			t.Fatalf("fixture occurred_at: %v", err)
		}
		event.OccurredAt = occurredAt
	}
	if f.Operation.PropertiesRecipe != nil {
		event.Properties = recipeProperties(*f.Operation.PropertiesRecipe)
	}
	var delays []time.Duration
	if len(f.Expect.JitterBounds) > 0 || len(f.Expect.MinimumDelays) > 0 {
		var delaysMu sync.Mutex
		ctx = retryobserver.With(ctx, func(delay time.Duration) {
			delaysMu.Lock()
			delays = append(delays, delay)
			delaysMu.Unlock()
		})
	}
	var stopPolling func()
	if f.Cancellation != nil && f.Cancellation.Phase == "during_request" {
		stopPolling = cancelWhenJournaled(control, cancel)
	}
	started := time.Now()
	ack, gotErr := dispatch(client, ctx, f.Operation, event)
	finished := time.Now()
	if stopPolling != nil {
		stopPolling()
	}
	assertResult(t, f, ack, gotErr)
	if len(f.Expect.JitterBounds) > 0 {
		assertJitterBounds(t, f, delays)
	}
	assertMinimumDelays(t, f, delays)
	requests, err := control.requests()
	if err != nil {
		t.Fatal(err)
	}
	assertJournal(t, f, requests, started, finished)
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
func cancelWhenJournaled(control *controlClient, cancel context.CancelFunc) func() {
	done := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		deadline := time.NewTimer(time.Second)
		defer deadline.Stop()
		for {
			requests, err := control.requests()
			if err == nil && len(requests) > 0 {
				cancel()
				return
			}
			select {
			case <-done:
				return
			case <-deadline.C:
				cancel()
				return
			case <-time.After(time.Millisecond):
			}
		}
	}()
	return func() { close(done); wait.Wait() }
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
		if operation.Amount == nil || operation.Currency == nil {
			return nil, fmt.Errorf("order_paid requires amount and currency")
		}
		return client.OrderPaid(ctx, *operation.Amount, *operation.Currency, event)
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
		case *cekat.ValidationError, *cekat.TransportError, *cekat.ResponseDecodeError, *cekat.APIError, *cekat.AuthenticationError, *cekat.EventDefinitionNotFoundError:
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
	case *cekat.APIError:
		status, message, serverError, serverCode, attempts, body = value.StatusCode, value.Message, value.Message, value.Code, value.Attempts, value.Body
		if f.Expect.Result != "api_error" {
			t.Fatalf("error type = APIError, want %s", f.Expect.Result)
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
func assertJitterBounds(t *testing.T, f fixture, delays []time.Duration) {
	t.Helper()
	if len(delays) != len(f.Expect.JitterBounds) {
		t.Fatalf("observed %d retry jitter delays, want %d", len(delays), len(f.Expect.JitterBounds))
	}
	for index, bounds := range f.Expect.JitterBounds {
		if len(bounds) != 2 {
			t.Fatalf("fixture jitter bounds[%d] invalid", index)
		}
		min, max := time.Duration(bounds[0])*time.Millisecond, time.Duration(bounds[1])*time.Millisecond
		if delays[index] < min || delays[index] > max {
			t.Fatalf("retry jitter delay[%d] = %s, want [%s, %s]", index, delays[index], min, max)
		}
	}
}
func assertGeneratedField(t *testing.T, index int, field, value string, started, finished time.Time) {
	t.Helper()
	switch field {
	case "event_id":
		if !generatedEventIDPattern.MatchString(value) {
			t.Fatalf("journal[%d] event_id = %q, want generated lowercase v4 UUID", index, value)
		}
	case "occurred_at":
		occurredAt, err := time.Parse("2006-01-02T15:04:05.000Z", value)
		if err != nil || occurredAt.Before(started.Add(-time.Second)) || occurredAt.After(finished.Add(time.Second)) {
			t.Fatalf("journal[%d] occurred_at = %q (%v), want canonical UTC milliseconds within the case window", index, value, err)
		}
	}
}

func assertMinimumDelays(t *testing.T, f fixture, delays []time.Duration) {
	t.Helper()
	if len(f.Expect.MinimumDelays) == 0 {
		return
	}
	if len(delays) != len(f.Expect.MinimumDelays) {
		t.Fatalf("observed %d retry delays, want %d", len(delays), len(f.Expect.MinimumDelays))
	}
	for index, minimum := range f.Expect.MinimumDelays {
		if want := time.Duration(minimum) * time.Millisecond; delays[index] < want {
			t.Fatalf("retry delay[%d] = %s, want at least %s", index, delays[index], want)
		}
	}
}

func assertBody(t *testing.T, f fixture, body []byte) {
	t.Helper()
	if f.Expect.RetainedBodyBytes != nil && len(body) != *f.Expect.RetainedBodyBytes {
		t.Fatalf("retained body bytes = %d, want %d", len(body), *f.Expect.RetainedBodyBytes)
	}
	if f.BodyRecipe == nil {
		return
	}
	expanded := []byte(expandBodyRecipe(f.BodyRecipe))
	if f.Expect.ObservedBodyBytes == nil || f.Expect.BodyTruncated == nil || f.Expect.RetainedBodyBytes == nil {
		t.Fatal("schema-valid response body recipe missing body expectations")
	}
	observed := len(expanded)
	if observed > 65537 {
		observed = 65537
	}
	if observed != *f.Expect.ObservedBodyBytes {
		t.Fatalf("recipe observed body bytes = %d, want %d", observed, *f.Expect.ObservedBodyBytes)
	}
	truncated := len(expanded) > 65536
	if truncated != *f.Expect.BodyTruncated {
		t.Fatalf("recipe body truncated = %t, want %t", truncated, *f.Expect.BodyTruncated)
	}
	retained := expanded
	if len(retained) > 65536 {
		retained = retained[:65536]
	}
	if !reflect.DeepEqual(body, retained) {
		t.Fatalf("retained body is not the declared response recipe prefix")
	}
	if truncated && !strings.Contains(strings.ToValidUTF8(string(body), "\uFFFD"), "\uFFFD") {
		t.Fatalf("truncated text body does not include replacement character")
	}
}

var (
	generatedEventIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	userAgentPattern        = regexp.MustCompile(`^cekat-event-sdk-go/[0-9]+\.[0-9]+\.[0-9]+[^ ]*( .+)?$`)
)

func assertJournal(t *testing.T, f fixture, requests []journalEntry, started, finished time.Time) {
	t.Helper()
	if len(requests) != f.Expect.Attempts {
		t.Fatalf("journal length = %d, want %d", len(requests), f.Expect.Attempts)
	}
	for index, request := range requests {
		if values := request.Headers["user-agent"]; len(values) != 1 || !userAgentPattern.MatchString(values[0]) {
			t.Fatalf("journal[%d] user-agent = %#v, want cekat-event-sdk-go/<semver>", index, values)
		}
	}
	if f.Expect.Request == nil {
		return
	}
	var expected map[string]any
	if err := json.Unmarshal(f.Expect.Request.Payload, &expected); err != nil {
		t.Fatal(err)
	}
	generated := map[string]string{}
	for index, request := range requests {
		if request.Sequence != index+1 || request.Method != http.MethodPost || request.Path != f.Expect.Request.Path {
			t.Fatalf("journal[%d] = %#v", index, request)
		}
		if values := request.Headers["authorization"]; !reflect.DeepEqual(values, []string{f.Expect.Request.Authorization}) {
			t.Fatalf("journal[%d] authorization = %#v", index, values)
		}
		var actual map[string]any
		if err := json.Unmarshal([]byte(request.Body), &actual); err != nil {
			t.Fatalf("journal[%d] JSON: %v", index, err)
		}
		for _, field := range []string{"event_id", "occurred_at"} {
			if _, declared := expected[field]; declared {
				continue
			}
			value, _ := actual[field].(string)
			assertGeneratedField(t, index, field, value, started, finished)
			if previous, seen := generated[field]; seen && previous != value {
				t.Fatalf("journal[%d] %s = %q, want %q reused across attempts", index, field, value, previous)
			}
			generated[field] = value
			delete(actual, field)
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("journal[%d] payload = %#v, want %#v", index, actual, expected)
		}
	}
}
