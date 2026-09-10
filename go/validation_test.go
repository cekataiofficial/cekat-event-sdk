package cekat

import (
	"errors"
	"math"
	"strings"
	"testing"
)

func TestValidateEvent(t *testing.T) {
	validEvent := Event{
		Email: " ada@example.test ",
		Properties: map[string]any{
			"order": map[string]any{
				"total": 12.5,
				"items": []any{nil, true, "sku", int64(9007199254740991)},
			},
		},
	}

	tests := []struct {
		name     string
		eventKey string
		event    Event
		wantPath string
	}{
		{name: "blank event key", eventKey: " \t", event: validEvent, wantPath: "event key"},
		{name: "missing identities", eventKey: "order_paid", event: Event{Email: " \n ", PhoneNumber: "\t"}, wantPath: "email or phone number"},
		{name: "NaN", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"risk": math.NaN()}}, wantPath: "properties.risk"},
		{name: "positive infinity", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"risk": math.Inf(1)}}, wantPath: "properties.risk"},
		{name: "negative infinity", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"risk": math.Inf(-1)}}, wantPath: "properties.risk"},
		{name: "unsafe positive integer", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"id": int64(9007199254740992)}}, wantPath: "properties.id"},
		{name: "unsafe negative integer", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"id": int64(-9007199254740992)}}, wantPath: "properties.id"},
		{name: "function", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"secret": func() {}}}, wantPath: "properties.secret"},
		{name: "channel", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"secret": make(chan int)}}, wantPath: "properties.secret"},
		{name: "complex", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"secret": complex(1, 2)}}, wantPath: "properties.secret"},
		{name: "struct", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"secret": struct{ Value string }{Value: "very-secret"}}}, wantPath: "properties.secret"},
		{name: "pointer", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"secret": new(string)}}, wantPath: "properties.secret"},
		{name: "nested non-string map key", eventKey: "order_paid", event: Event{Email: "ada@example.test", Properties: map[string]any{"order": map[int]any{1: "very-secret"}}}, wantPath: "properties.order"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEvent(tt.eventKey, tt.event)
			if err == nil {
				t.Fatal("validateEvent() error = nil, want validation error")
			}
			var validationErr *ValidationError
			if !errors.As(err, &validationErr) {
				t.Fatalf("validateEvent() error type = %T, want *ValidationError", err)
			}
			if !strings.Contains(err.Error(), tt.wantPath) {
				t.Errorf("validateEvent() error = %q, want path %q", err, tt.wantPath)
			}
			if strings.Contains(err.Error(), "very-secret") {
				t.Fatalf("validateEvent() error leaked rejected property value: %q", err)
			}
		})
	}

	if err := validateEvent("order_paid", validEvent); err != nil {
		t.Fatalf("validateEvent() valid nested event error = %v", err)
	}
}

func TestValidateEventRejectsCycles(t *testing.T) {
	mapCycle := map[string]any{}
	mapCycle["self"] = mapCycle

	sliceCycle := []any{nil}
	sliceCycle[0] = sliceCycle

	for _, tt := range []struct {
		name       string
		properties map[string]any
	}{
		{name: "map", properties: mapCycle},
		{name: "slice", properties: map[string]any{"items": sliceCycle}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEvent("order_paid", Event{Email: "ada@example.test", Properties: tt.properties})
			if err == nil || !strings.Contains(err.Error(), "cycle") {
				t.Fatalf("validateEvent() error = %v, want cycle rejection", err)
			}
		})
	}
}

func TestBuildPayloadPreservesIdentityWhitespaceAndCopiesProperties(t *testing.T) {
	properties := map[string]any{
		"order": map[string]any{"items": []any{"first"}},
	}
	event := Event{
		Email:       " ada@example.test ",
		PhoneNumber: " +6281 ",
		ContactName: " Ada ",
		VisitorID:   " visitor-id ",
		Properties:  properties,
	}

	payload, err := buildPayload(" custom_event ", false, event)
	if err != nil {
		t.Fatalf("buildPayload() error = %v", err)
	}
	if got, want := payload.EventKey, " custom_event "; got != want {
		t.Errorf("EventKey = %q, want %q", got, want)
	}
	if payload.IsCommon {
		t.Error("IsCommon = true, want false")
	}
	if got, want := payload.Email, event.Email; got != want {
		t.Errorf("Email = %q, want unchanged %q", got, want)
	}
	if got, want := payload.PhoneNumber, event.PhoneNumber; got != want {
		t.Errorf("PhoneNumber = %q, want unchanged %q", got, want)
	}
	if got, want := payload.ContactName, event.ContactName; got != want {
		t.Errorf("ContactName = %q, want unchanged %q", got, want)
	}
	if got, want := payload.VisitorID, event.VisitorID; got != want {
		t.Errorf("VisitorID = %q, want unchanged %q", got, want)
	}

	properties["order"].(map[string]any)["items"].([]any)[0] = "changed"
	if got, want := payload.Properties["order"].(map[string]any)["items"].([]any)[0], any("first"); got != want {
		t.Errorf("copied property = %#v, want %#v", got, want)
	}
}

func TestBuildPayloadRejectsInvalidEvent(t *testing.T) {
	if _, err := buildPayload("order_paid", true, Event{ContactName: "Ada"}); err == nil {
		t.Fatal("buildPayload() error = nil, want identity validation error")
	}
}

func FuzzValidateProperties(f *testing.F) {
	f.Add("order", "total", int64(42))
	f.Add("items", "sku", int64(-9007199254740991))

	f.Fuzz(func(t *testing.T, outerKey, innerKey string, amount int64) {
		properties := map[string]any{outerKey: map[string]any{innerKey: []any{amount, "value"}}}
		before := properties[outerKey].(map[string]any)[innerKey].([]any)[1]
		err := validateEvent("order_paid", Event{Email: "ada@example.test", Properties: properties})
		if amount >= -9007199254740991 && amount <= 9007199254740991 && err != nil {
			t.Fatalf("validateEvent() error = %v for safe integer", err)
		}
		if got := properties[outerKey].(map[string]any)[innerKey].([]any)[1]; got != before {
			t.Fatalf("validateEvent() mutated properties: got %#v, want %#v", got, before)
		}
		if err != nil && strings.Contains(err.Error(), `"value"`) {
			t.Fatalf("validateEvent() leaked rendered property value: %q", err)
		}
	})
}
