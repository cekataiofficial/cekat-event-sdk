package cekat

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"testing"
	"time"
)

type namedBool bool
type namedString string
type namedInt int
type namedUint uint
type namedFloat float32
type namedStringSlice []namedString
type namedIntArray [2]namedInt
type namedIntMap map[string]namedInt
type namedJSONMarshaler string

func (value namedJSONMarshaler) MarshalJSON() ([]byte, error) {
	return json.Marshal("marshaler escape: " + string(value))
}

// textID mirrors identifier types such as github.com/google/uuid.UUID: a byte
// array that serializes through encoding.TextMarshaler.
type textID [4]byte

func (id textID) MarshalText() ([]byte, error) {
	return []byte("id-01020304"), nil
}

func TestValidateEvent(t *testing.T) {
	for _, tt := range []struct {
		name     string
		eventKey string
		event    Event
		wantText string
	}{
		{name: "blank event key", eventKey: " \t", event: Event{Email: "ada@example.test"}, wantText: "event key"},
		{name: "missing identities", eventKey: "order_paid", event: Event{Email: " \n ", PhoneNumber: "\t"}, wantText: "email or phone number"},
		{name: "occurred at before year one", eventKey: "order_paid", event: Event{Email: "ada@example.test", OccurredAt: time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC)}, wantText: "occurred at"},
		{name: "occurred at after year 9999", eventKey: "order_paid", event: Event{Email: "ada@example.test", OccurredAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}, wantText: "occurred at"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEvent(tt.eventKey, tt.event)
			var validationErr *ValidationError
			if !errors.As(err, &validationErr) || !strings.Contains(err.Error(), tt.wantText) {
				t.Fatalf("validateEvent() error = %v, want *ValidationError mentioning %q", err, tt.wantText)
			}
		})
	}
	if err := validateEvent("order_paid", Event{PhoneNumber: "+6281"}); err != nil {
		t.Fatalf("validateEvent() valid event error = %v", err)
	}
}

func TestBuildPayloadRejectsNonPortableProperties(t *testing.T) {
	mapCycle := map[string]any{}
	mapCycle["self"] = mapCycle
	sliceCycle := []any{nil}
	sliceCycle[0] = sliceCycle

	for _, tt := range []struct {
		name       string
		properties map[string]any
		wantText   string
	}{
		{name: "NaN", properties: map[string]any{"risk": math.NaN()}, wantText: "properties"},
		{name: "positive infinity", properties: map[string]any{"risk": math.Inf(1)}, wantText: "properties"},
		{name: "negative infinity", properties: map[string]any{"risk": math.Inf(-1)}, wantText: "properties"},
		{name: "unsafe positive integer", properties: map[string]any{"id": int64(9007199254740992)}, wantText: "properties.id"},
		{name: "unsafe negative integer", properties: map[string]any{"id": int64(-9007199254740992)}, wantText: "properties.id"},
		{name: "unsafe unsigned integer", properties: map[string]any{"id": uint64(math.MaxUint64)}, wantText: "properties.id"},
		{name: "unsafe positive integral float", properties: map[string]any{"id": float64(9007199254740992)}, wantText: "properties.id"},
		{name: "unsafe negative integral float", properties: map[string]any{"id": float64(-9007199254740992)}, wantText: "properties.id"},
		{name: "nested unsafe integer", properties: map[string]any{"order": map[string]any{"items": []any{int64(1), int64(1 << 60)}}}, wantText: "properties.order.items[1]"},
		{name: "function", properties: map[string]any{"secret": func() {}}, wantText: "properties"},
		{name: "channel", properties: map[string]any{"secret": make(chan int)}, wantText: "properties"},
		{name: "complex", properties: map[string]any{"secret": complex(1, 2)}, wantText: "properties"},
		// Struct keys cannot become JSON object names in any Go release. (Go 1.27 started
		// encoding float, interface, and pointer keys, so those are not stable examples.)
		{name: "unencodable map key", properties: map[string]any{"order": map[struct{ ID int }]any{{ID: 1}: "very-secret"}}, wantText: "properties"},
		{name: "map cycle", properties: mapCycle, wantText: "cycle"},
		{name: "slice cycle", properties: map[string]any{"items": sliceCycle}, wantText: "cycle"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := buildPayload(context.Background(), "order_paid", true, Event{Email: "ada@example.test", Properties: tt.properties})
			var validationErr *ValidationError
			if !errors.As(err, &validationErr) {
				t.Fatalf("buildPayload() error = %T %v, want *ValidationError", err, err)
			}
			if !strings.Contains(err.Error(), tt.wantText) {
				t.Errorf("buildPayload() error = %q, want %q", err, tt.wantText)
			}
			if strings.Contains(err.Error(), "very-secret") {
				t.Fatalf("buildPayload() error leaked rejected property value: %q", err)
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

	payload, err := buildPayload(context.Background(), " custom_event ", false, event)
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
	if got, want := payload.VisitorID, "visitor-id"; got != want {
		t.Errorf("VisitorID = %q, want trimmed %q", got, want)
	}

	properties["order"].(map[string]any)["items"].([]any)[0] = "changed"
	if got, want := payload.Properties["order"].(map[string]any)["items"].([]any)[0], any("first"); got != want {
		t.Errorf("copied property = %#v, want %#v", got, want)
	}
}

func TestBuildPayloadRejectsInvalidEvent(t *testing.T) {
	if _, err := buildPayload(context.Background(), "order_paid", true, Event{ContactName: "Ada"}); err == nil {
		t.Fatal("buildPayload() error = nil, want identity validation error")
	}
}

func TestBuildPayloadEncodesPropertiesWithStandardJSON(t *testing.T) {
	text := "pointer value"
	var nilPointer *string
	occurred := time.Date(2026, 9, 13, 8, 15, 30, 250_000_000, time.FixedZone("WIB", 7*60*60))
	payload, err := buildPayload(context.Background(), "order_paid", true, Event{
		Email: "ada@example.test",
		Properties: map[string]any{
			"bytes":     []byte{1, 2},
			"raw":       json.RawMessage(`{"raw":true}`),
			"marshaler": namedJSONMarshaler("original"),
			"text_id":   textID{1, 2, 3, 4},
			"time":      occurred,
			"pointer":   &text,
			"nil":       nilPointer,
			"struct": struct {
				Name string `json:"name"`
			}{Name: "sku"},
			"int_key":    map[int]string{1: "one"},
			"bool":       namedBool(true),
			"string":     namedString("sku"),
			"int":        namedInt(42),
			"uint":       namedUint(43),
			"float":      namedFloat(1.5),
			"safe_float": 125.75,
			"slice":      namedStringSlice{"first", "second"},
			"array":      namedIntArray{7, 8},
			"map":        namedIntMap{"count": 3},
		},
	})
	if err != nil {
		t.Fatalf("buildPayload() error = %v", err)
	}

	encoded, err := json.Marshal(payload.Properties)
	if err != nil {
		t.Fatalf("json.Marshal(properties) error = %v", err)
	}
	var got any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("json.Unmarshal(properties) error = %v", err)
	}
	var want any
	if err := json.Unmarshal([]byte(`{"array":[7,8],"bool":true,"bytes":"AQI=","float":1.5,"int":42,"int_key":{"1":"one"},"map":{"count":3},"marshaler":"marshaler escape: original","nil":null,"pointer":"pointer value","raw":{"raw":true},"safe_float":125.75,"slice":["first","second"],"string":"sku","struct":{"name":"sku"},"text_id":"id-01020304","time":"2026-09-13T08:15:30.25+07:00","uint":43}`), &want); err != nil {
		t.Fatalf("json.Unmarshal(want) error = %v", err)
	}
	if !jsonValuesEqual(got, want) {
		t.Errorf("properties = %s, want standard encoding/json forms", encoded)
	}
}

var uuidV4Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestBuildPayloadEventIDAndOccurredAt(t *testing.T) {
	t.Run("generated", func(t *testing.T) {
		before := time.Now().UTC().Truncate(time.Millisecond)
		first, err := buildPayload(context.Background(), "order_paid", true, Event{Email: "ada@example.test", EventID: " \t"})
		if err != nil {
			t.Fatalf("buildPayload() error = %v", err)
		}
		after := time.Now().UTC()
		second, _ := buildPayload(context.Background(), "order_paid", true, Event{Email: "ada@example.test"})
		if !uuidV4Pattern.MatchString(first.EventID) || !uuidV4Pattern.MatchString(second.EventID) || first.EventID == second.EventID {
			t.Errorf("generated event IDs = %q, %q, want distinct lowercase v4 UUIDs", first.EventID, second.EventID)
		}
		occurredAt, err := time.Parse(occurredAtLayout, first.OccurredAt)
		if err != nil || occurredAt.Before(before) || occurredAt.After(after) {
			t.Errorf("generated OccurredAt = %q (%v), want call time between %v and %v", first.OccurredAt, err, before, after)
		}
	})
	t.Run("explicit", func(t *testing.T) {
		occurred := time.Date(2026, 9, 13, 8, 15, 30, 250_999_999, time.FixedZone("WIB", 7*60*60))
		payload, err := buildPayload(context.Background(), "order_paid", true, Event{Email: "ada@example.test", EventID: " evt-123 ", OccurredAt: occurred})
		if err != nil {
			t.Fatalf("buildPayload() error = %v", err)
		}
		if payload.EventID != "evt-123" || payload.OccurredAt != "2026-09-13T01:15:30.250Z" {
			t.Errorf("payload = (%q, %q), want trimmed event ID and truncated UTC milliseconds", payload.EventID, payload.OccurredAt)
		}
	})
}

func jsonValuesEqual(got, want any) bool {
	gotJSON, err := json.Marshal(got)
	if err != nil {
		return false
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		return false
	}
	return string(gotJSON) == string(wantJSON)
}

func FuzzNormalizeProperties(f *testing.F) {
	f.Add("order", "total", int64(42))
	f.Add("items", "sku", int64(-9007199254740991))

	f.Fuzz(func(t *testing.T, outerKey, innerKey string, amount int64) {
		properties := map[string]any{outerKey: map[string]any{innerKey: []any{amount, "value"}}}
		before := properties[outerKey].(map[string]any)[innerKey].([]any)[1]
		_, err := normalizeProperties(properties)
		if amount >= -9007199254740991 && amount <= 9007199254740991 && err != nil {
			t.Fatalf("normalizeProperties() error = %v for safe integer", err)
		}
		if (amount < -9007199254740991 || amount > 9007199254740991) && err == nil {
			t.Fatalf("normalizeProperties() accepted unsafe integer %d", amount)
		}
		if got := properties[outerKey].(map[string]any)[innerKey].([]any)[1]; got != before {
			t.Fatalf("normalizeProperties() mutated properties: got %#v, want %#v", got, before)
		}
		if err != nil && strings.Contains(err.Error(), `"value"`) {
			t.Fatalf("normalizeProperties() leaked rendered property value: %q", err)
		}
	})
}
