package conformance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type fixture struct {
	SchemaVersion int            `json:"schema_version"`
	ID            string         `json:"id"`
	Description   string         `json:"description"`
	Kind          string         `json:"kind"`
	Applicability *applicability `json:"applicability"`
	Client        clientRecipe   `json:"client"`
	Inbound       inboundRecipe  `json:"inbound"`
	Operation     operation      `json:"operation"`
	Responses     []mockResponse `json:"responses"`
	BodyRecipe    *bodyRecipe    `json:"response_body_recipe"`
	Cancellation  *cancellation  `json:"cancellation"`
	Expect        expectation    `json:"expect"`
}

type applicability struct {
	Requires     []string `json:"requires_capabilities"`
	Inapplicable []string `json:"inapplicable_languages"`
}
type clientRecipe struct {
	TimeoutMS  *int `json:"timeout_ms"`
	RetryCount *int `json:"retry_count"`
}
type inboundRecipe struct {
	HeaderVisitorID  *string `json:"header_visitor_id"`
	CookieVisitorID  *string `json:"cookie_visitor_id"`
	AmbientVisitorID *string `json:"ambient_visitor_id"`
}
type operation struct {
	Name             string      `json:"name"`
	EventKey         *string     `json:"event_key"`
	Event            eventRecipe `json:"event"`
	PropertiesRecipe *string     `json:"properties_recipe"`
}
type eventRecipe struct {
	Email       *string        `json:"email"`
	PhoneNumber *string        `json:"phone_number"`
	ContactName *string        `json:"contact_name"`
	VisitorID   *string        `json:"visitor_id"`
	EventID     *string        `json:"event_id"`
	OccurredAt  *string        `json:"occurred_at"`
	Properties  map[string]any `json:"properties"`
}
type mockResponse struct {
	Status     *int              `json:"status,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       string            `json:"body"`
	DelayMS    *int              `json:"delay_ms,omitempty"`
	Disconnect *bool             `json:"disconnect_before_headers,omitempty"`
	// DisconnectAfter interrupts the response body after headers are sent.
	DisconnectAfter *bool `json:"disconnect_after_headers,omitempty"`
}
type bodyRecipe struct {
	Unit         string `json:"unit"`
	MinimumBytes int    `json:"minimum_utf8_bytes"`
	Suffix       string `json:"suffix"`
}
type cancellation struct {
	Phase string `json:"phase"`
}
type expectation struct {
	Result            string           `json:"result"`
	Attempts          int              `json:"attempts"`
	DeliveryUnknown   *bool            `json:"delivery_outcome_unknown"`
	Acknowledgement   *ackExpectation  `json:"acknowledgement"`
	Status            *int             `json:"status"`
	ErrorMessage      *string          `json:"error_message"`
	ServerError       *string          `json:"server_error"`
	ServerCode        *string          `json:"server_code"`
	RetainedBodyBytes *int             `json:"retained_body_bytes"`
	ObservedBodyBytes *int             `json:"observed_body_bytes"`
	BodyTruncated     *bool            `json:"body_truncated"`
	Request           *expectedRequest `json:"request"`
	MinimumDelays     []int            `json:"minimum_retry_delays_ms"`
	JitterBounds      [][]int          `json:"jitter_bounds_ms"`
}
type ackExpectation struct {
	Success             bool     `json:"success"`
	Message             string   `json:"message"`
	EventKey            string   `json:"event_key"`
	ValidatedProperties []string `json:"validated_properties"`
}
type expectedRequest struct {
	Path          string          `json:"path"`
	Authorization string          `json:"authorization"`
	Payload       json.RawMessage `json:"payload"`
}

func loadFixtures(directory string) ([]fixture, error) {
	if !filepath.IsAbs(directory) {
		return nil, fmt.Errorf("CEKAT_CONFORMANCE_FIXTURES must be absolute")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read fixtures: %w", err)
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("fixture corpus is empty")
	}
	schema, err := loadCaseSchema(filepath.Join(filepath.Dir(directory), "schemas"))
	if err != nil {
		return nil, fmt.Errorf("load shared case schema: %w", err)
	}
	fixtures := make([]fixture, 0, len(entries))
	ids := map[string]struct{}{}
	for _, entry := range entries {
		if entry.IsDir() {
			return nil, fmt.Errorf("fixture directory contains subdirectory %q", entry.Name())
		}
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, err
		}
		if err := validateCaseJSON(schema, data); err != nil {
			return nil, fmt.Errorf("fixture %q does not satisfy the shared schema: %w", entry.Name(), err)
		}
		var value fixture
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&value); err != nil {
			return nil, fmt.Errorf("fixture %q: %w", entry.Name(), err)
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			return nil, fmt.Errorf("fixture %q: trailing JSON value", entry.Name())
		}
		if value.ID != strings.TrimSuffix(entry.Name(), ".json") {
			return nil, fmt.Errorf("fixture %q: filename/ID mismatch: %q", entry.Name(), value.ID)
		}
		if _, found := ids[value.ID]; found {
			return nil, fmt.Errorf("duplicate fixture ID %q", value.ID)
		}
		ids[value.ID] = struct{}{}
		fixtures = append(fixtures, value)
	}
	if len(fixtures) == 0 {
		return nil, fmt.Errorf("fixture corpus contains no direct JSON files")
	}
	return fixtures, nil
}

// loadCaseSchema compiles the complete shared JSON Schema and every referenced
// schema. Fixtures are validated before decoding so Go's permissive handling of
// JSON null values cannot make an invalid fixture executable.
func loadCaseSchema(schemaDirectory string) (*jsonschema.Schema, error) {
	compiler := jsonschema.NewCompiler()
	resources := map[string]string{
		"https://schemas.cekat.ai/event-sdk/conformance/conformance-case.schema.json":    "conformance-case.schema.json",
		"https://schemas.cekat.ai/event-sdk/conformance/mock-response-queue.schema.json": "mock-response-queue.schema.json",
		"https://schemas.cekat.ai/event-sdk/conformance/event-payload.schema.json":       "event-payload.schema.json",
		"https://schemas.cekat.ai/event-sdk/conformance/json-value.schema.json":          "json-value.schema.json",
	}
	for url, name := range resources {
		data, err := os.ReadFile(filepath.Join(schemaDirectory, name))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", name, err)
		}
		var document any
		if err := json.Unmarshal(data, &document); err != nil {
			return nil, fmt.Errorf("decode %s: %w", name, err)
		}
		if err := compiler.AddResource(url, document); err != nil {
			return nil, fmt.Errorf("add %s: %w", name, err)
		}
	}
	return compiler.Compile("https://schemas.cekat.ai/event-sdk/conformance/conformance-case.schema.json")
}

func validateCaseJSON(schema *jsonschema.Schema, data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("trailing JSON value")
	}
	return schema.Validate(value)
}

func validateFixtureShape(data []byte) error {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return err
	}
	if err := closedObject(root, []string{"schema_version", "id", "description", "kind", "applicability", "client", "inbound", "operation", "responses", "response_body_recipe", "cancellation", "expect"}, []string{"schema_version", "id", "description", "kind", "operation", "expect"}); err != nil {
		return err
	}
	if err := checkObject(root["operation"], []string{"name", "event_key", "event", "properties_recipe"}, []string{"name", "event"}); err != nil {
		return fmt.Errorf("operation: %w", err)
	}
	var operation map[string]json.RawMessage
	_ = json.Unmarshal(root["operation"], &operation)
	if err := checkObject(operation["event"], []string{"email", "phone_number", "contact_name", "visitor_id", "event_id", "occurred_at", "properties"}, nil); err != nil {
		return fmt.Errorf("operation.event: %w", err)
	}
	if err := checkObject(root["expect"], []string{"result", "attempts", "delivery_outcome_unknown", "acknowledgement", "status", "error_message", "server_error", "server_code", "retained_body_bytes", "observed_body_bytes", "body_truncated", "request", "minimum_retry_delays_ms", "jitter_bounds_ms"}, []string{"result", "attempts"}); err != nil {
		return fmt.Errorf("expect: %w", err)
	}
	var expect map[string]json.RawMessage
	_ = json.Unmarshal(root["expect"], &expect)
	if raw, ok := expect["acknowledgement"]; ok {
		if err := checkObject(raw, []string{"success", "message", "event_key", "validated_properties"}, []string{"success", "message", "event_key", "validated_properties"}); err != nil {
			return fmt.Errorf("expect.acknowledgement: %w", err)
		}
	}
	if raw, ok := expect["request"]; ok {
		if err := checkObject(raw, []string{"path", "authorization", "payload"}, []string{"path", "authorization", "payload"}); err != nil {
			return fmt.Errorf("expect.request: %w", err)
		}
	}
	for name, definition := range map[string]struct{ allowed, required []string }{"applicability": {[]string{"requires_capabilities", "inapplicable_languages"}, []string{"requires_capabilities", "inapplicable_languages"}}, "client": {[]string{"timeout_ms", "retry_count"}, nil}, "inbound": {[]string{"header_visitor_id", "cookie_visitor_id", "ambient_visitor_id"}, nil}, "response_body_recipe": {[]string{"unit", "minimum_utf8_bytes", "suffix"}, []string{"unit", "minimum_utf8_bytes", "suffix"}}, "cancellation": {[]string{"phase"}, []string{"phase"}}} {
		if raw, ok := root[name]; ok {
			if err := checkObject(raw, definition.allowed, definition.required); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		}
	}
	if raw, ok := root["responses"]; ok {
		var responses []json.RawMessage
		if err := json.Unmarshal(raw, &responses); err != nil {
			return fmt.Errorf("responses must be an array")
		}
		for i, response := range responses {
			if err := checkObject(response, []string{"status", "headers", "body", "delay_ms", "disconnect_before_headers", "disconnect_after_headers"}, []string{"body"}); err != nil {
				return fmt.Errorf("responses[%d]: %w", i, err)
			}
		}
	}
	return nil
}
func checkObject(raw json.RawMessage, allowed, required []string) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return fmt.Errorf("must be an object")
	}
	return closedObject(object, allowed, required)
}
func closedObject(object map[string]json.RawMessage, allowed, required []string) error {
	permitted := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		permitted[key] = struct{}{}
	}
	for key := range object {
		if _, ok := permitted[key]; !ok {
			return fmt.Errorf("unknown field %q", key)
		}
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return fmt.Errorf("missing required field %q", key)
		}
	}
	return nil
}

func validateFixture(f fixture, filenameID string) error {
	if f.SchemaVersion != 1 {
		return fmt.Errorf("unknown schema_version %d", f.SchemaVersion)
	}
	if f.ID == "" || f.ID != filenameID {
		return fmt.Errorf("filename/ID mismatch: %q", f.ID)
	}
	if f.Description == "" {
		return fmt.Errorf("description is required")
	}
	if !oneOf(f.Kind, "request", "validation", "success", "error", "retry", "cancellation") {
		return fmt.Errorf("unknown kind %q", f.Kind)
	}
	if !oneOf(f.Operation.Name, "user_registration", "user_login", "order_created", "order_paid", "custom_event") {
		return fmt.Errorf("unknown operation name %q", f.Operation.Name)
	}
	if f.Operation.PropertiesRecipe != nil && f.Operation.Event.Properties != nil {
		return fmt.Errorf("properties recipe cannot accompany literal properties")
	}
	if f.Operation.PropertiesRecipe != nil && !oneOf(*f.Operation.PropertiesRecipe, "nan", "positive_infinity", "negative_infinity", "unsafe_integer_high", "unsafe_integer_low", "cycle", "non_string_key", "runtime_object") {
		return fmt.Errorf("unknown properties recipe %q", *f.Operation.PropertiesRecipe)
	}
	if f.Client.TimeoutMS != nil && *f.Client.TimeoutMS <= 0 {
		return fmt.Errorf("invalid timeout_ms")
	}
	if f.Client.RetryCount != nil && *f.Client.RetryCount < 0 {
		return fmt.Errorf("invalid retry_count")
	}
	if f.BodyRecipe != nil && (f.BodyRecipe.Unit == "" || f.BodyRecipe.MinimumBytes < 65537) {
		return fmt.Errorf("unknown response-body recipe form")
	}
	if f.Cancellation != nil && !oneOf(f.Cancellation.Phase, "before_request", "during_request", "during_backoff") {
		return fmt.Errorf("unknown cancellation phase %q", f.Cancellation.Phase)
	}
	if err := validateApplicability(f.Applicability); err != nil {
		return err
	}
	for _, response := range f.Responses {
		if err := validateMockResponse(response); err != nil {
			return err
		}
	}
	if !oneOf(f.Expect.Result, "acknowledgement", "validation_error", "authentication_error", "event_definition_not_found_error", "api_error", "transport_error", "response_decode_error", "caller_cancelled") {
		return fmt.Errorf("unknown expect.result %q", f.Expect.Result)
	}
	if f.Expect.Attempts < 0 {
		return fmt.Errorf("invalid expected attempts")
	}
	if (f.Expect.Result == "api_error" || f.Expect.Result == "authentication_error" || f.Expect.Result == "event_definition_not_found_error") && (f.Expect.ErrorMessage == nil || *f.Expect.ErrorMessage == "") {
		return fmt.Errorf("HTTP error result requires error_message")
	}
	return nil
}
func validateApplicability(a *applicability) error {
	if a == nil {
		return nil
	}
	if len(a.Requires) != 1 || a.Requires[0] != "caller_cancellation" || len(a.Inapplicable) != 2 || a.Inapplicable[0] != "php" || a.Inapplicable[1] != "ruby" {
		return fmt.Errorf("unknown or invalid applicability declaration")
	}
	return nil
}
func validateMockResponse(r mockResponse) error {
	if r.Disconnect != nil && *r.Disconnect {
		if r.Status != nil {
			return fmt.Errorf("invalid mock-response form")
		}
		return nil
	}
	if r.Status == nil || *r.Status < 200 || *r.Status > 599 {
		return fmt.Errorf("invalid mock-response form")
	}
	if r.Disconnect != nil && r.DisconnectAfter != nil && *r.DisconnectAfter {
		return fmt.Errorf("invalid mock-response form")
	}
	if r.DelayMS != nil && *r.DelayMS < 0 {
		return fmt.Errorf("invalid mock-response form")
	}
	return nil
}
func absoluteHTTPOrigin(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Hostname() == "" || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", fmt.Errorf("must be an absolute pathless HTTP(S) origin")
	}
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
func expandBodyRecipe(recipe *bodyRecipe) string {
	if recipe == nil {
		return ""
	}
	body := ""
	for len([]byte(body)) < recipe.MinimumBytes {
		body += recipe.Unit
	}
	return body + recipe.Suffix
}
func recipeProperties(recipe string) map[string]any {
	switch recipe {
	case "nan":
		return map[string]any{"value": math.NaN()}
	case "positive_infinity":
		return map[string]any{"value": math.Inf(1)}
	case "negative_infinity":
		return map[string]any{"value": math.Inf(-1)}
	case "unsafe_integer_high":
		return map[string]any{"value": int64(9007199254740992)}
	case "unsafe_integer_low":
		return map[string]any{"value": int64(-9007199254740992)}
	case "cycle":
		value := map[string]any{}
		value["self"] = value
		return value
	case "non_string_key":
		// encoding/json stringifies integer and TextMarshaler keys, so Go's
		// non-representable key is a float.
		return map[string]any{"value": map[float64]string{1: "one"}}
	case "runtime_object":
		// Structs, pointers, and marshalers have standard JSON forms in Go; a
		// channel is the runtime object encoding/json cannot represent.
		return map[string]any{"value": make(chan int)}
	default:
		panic("validated recipe")
	}
}
