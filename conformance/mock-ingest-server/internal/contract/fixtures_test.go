package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const fixturesPattern = "../../../fixtures/cases/*.json"

func loadCases(t *testing.T) map[string]map[string]any {
	t.Helper()

	paths, err := filepath.Glob(fixturesPattern)
	if err != nil {
		t.Fatalf("discover case fixtures: %v", err)
	}
	if len(paths) == 0 {
		t.Fatalf("discover case fixtures: no files matched %s", fixturesPattern)
	}

	cases := make(map[string]map[string]any, len(paths))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		var fixture map[string]any
		if err := json.Unmarshal(data, &fixture); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		cases[path] = fixture
	}
	return cases
}

func TestCaseIDsAndTokens(t *testing.T) {
	cases := loadCases(t)
	if len(cases) != 49 {
		t.Errorf("discovered %d conformance cases, want 49", len(cases))
	}
	ids := make(map[string]string, len(cases))

	for path, fixture := range cases {
		id, ok := fixture["id"].(string)
		if !ok {
			t.Errorf("%s id is not a string", path)
			continue
		}
		stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		if id != stem {
			t.Errorf("%s id = %q, want filename stem %q", path, id, stem)
		}
		if previous, duplicate := ids[id]; duplicate {
			t.Errorf("duplicate case id %q in %s and %s", id, previous, path)
		}
		ids[id] = path

		if version, ok := fixture["schema_version"].(float64); !ok || version != 1 {
			t.Errorf("%s schema_version = %v, want 1", path, fixture["schema_version"])
		}
		checkAuthorizationValues(t, path, "", fixture)
	}
}

func checkAuthorizationValues(t *testing.T, path, key string, value any) {
	t.Helper()

	switch typed := value.(type) {
	case map[string]any:
		for childKey, child := range typed {
			checkAuthorizationValues(t, path, childKey, child)
		}
	case []any:
		for _, child := range typed {
			checkAuthorizationValues(t, path, key, child)
		}
	case string:
		if (key == "authorization" || strings.HasPrefix(typed, "Bearer ")) && typed != "Bearer conformance-token" {
			t.Errorf("%s contains non-fixture authorization value %q", path, typed)
		}
	}
}

func TestRequestOperationCoverage(t *testing.T) {
	want := []string{"custom_event", "order_created", "order_paid", "user_login", "user_registration"}
	seen := make(map[string]bool)
	for path, fixture := range loadCases(t) {
		if fixture["kind"] != "request" {
			continue
		}
		operation, ok := fixture["operation"].(map[string]any)
		if !ok {
			t.Errorf("%s operation is not an object", path)
			continue
		}
		name, ok := operation["name"].(string)
		if !ok {
			t.Errorf("%s operation.name is not a string", path)
			continue
		}
		seen[name] = true
	}

	var got []string
	for name := range seen {
		got = append(got, name)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("request operation names = %v, want %v", got, want)
	}
}

func TestRequiredBehaviorCoverage(t *testing.T) {
	cases := loadCases(t)
	requiredIDs := []string{
		"success-valid",
		"success-malformed-outer-false",
		"success-malformed-data-success-missing",
		"success-malformed-data-success-false",
		"success-malformed-blank-message",
		"success-malformed-blank-event-key",
		"success-malformed-validated-properties-object",
		"success-malformed-validated-property-non-string",
		"success-malformed-json",
		"success-bounded-multibyte-body",
		"error-400-structured",
		"error-401-structured",
		"error-404-structured",
		"error-malformed-body",
		"error-bounded-multibyte-body",
		"retry-default-500-500-success",
		"retry-500-500-success",
		"retry-disconnect-disconnect-success",
		"retry-timeout-timeout-success",
		"retry-mixed-final-500",
		"retry-mixed-final-transport",
		"retry-no-400",
		"retry-no-401",
		"retry-no-404",
		"retry-no-429",
		"cancellation-before-request",
		"cancellation-during-request",
		"cancellation-during-backoff",
	}
	byID := make(map[string]map[string]any, len(cases))
	for path, fixture := range cases {
		id, _ := fixture["id"].(string)
		byID[id] = fixture
		_ = path
	}
	for _, id := range requiredIDs {
		if _, ok := byID[id]; !ok {
			t.Fatalf("required behavior fixture %q is missing", id)
		}
	}
	if len(cases) != 49 {
		t.Errorf("discovered %d cases, want 49", len(cases))
	}

	assertCanonicalResponse(t, byID["success-valid"])
	for _, malformed := range []struct {
		id, body string
	}{
		{"success-malformed-outer-false", `{"success":false,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}`},
		{"success-malformed-data-success-missing", `{"success":true,"data":{"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}`},
		{"success-malformed-data-success-false", `{"success":true,"data":{"success":false,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}`},
		{"success-malformed-blank-message", `{"success":true,"data":{"success":true,"message":"","event_key":"order_paid","validated_properties":["order_id"]}}`},
		{"success-malformed-blank-event-key", `{"success":true,"data":{"success":true,"message":"accepted","event_key":"","validated_properties":["order_id"]}}`},
		{"success-malformed-validated-properties-object", `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":{}}}`},
		{"success-malformed-validated-property-non-string", `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":[1]}}`},
		{"success-malformed-json", `{not-json`},
	} {
		assertMalformedSuccess(t, malformed.id, byID[malformed.id], malformed.body)
	}
	for _, typed := range []struct {
		id, result string
		status     float64
	}{
		{"error-400-structured", "api_error", 400},
		{"error-401-structured", "authentication_error", 401},
		{"error-404-structured", "event_definition_not_found_error", 404},
	} {
		assertStructuredHTTPError(t, typed.id, byID[typed.id], typed.result, typed.status)
	}
	assertMalformedHTTPError(t, "error-malformed-body", byID["error-malformed-body"], 418, "I'm a teapot")
	assertMalformedHTTPError(t, "error-bounded-multibyte-body", byID["error-bounded-multibyte-body"], 400, "Bad Request")
	assertRetrySemantics(t, byID)
	assertCancellationSemantics(t, byID)

	languages := map[string]bool{"go": true, "node": true, "python": true, "php": true, "java": true, "dotnet": true, "ruby": true}
	cancellationIDs := map[string]bool{
		"cancellation-before-request": true,
		"cancellation-during-request": true,
		"cancellation-during-backoff": true,
	}
	for path, fixture := range cases {
		id, _ := fixture["id"].(string)
		applicability, declared := fixture["applicability"]
		if !declared {
			if cancellationIDs[id] {
				t.Errorf("%s cancellation case must declare caller_cancellation applicability", path)
			}
			for language := range languages {
				if !caseAppliesToLanguage(fixture, language) {
					t.Errorf("%s without applicability must apply to %s", path, language)
				}
			}
			continue
		}
		if !cancellationIDs[id] {
			t.Errorf("%s declares applicability, but only the three cancellation cases may be inapplicable", path)
		}
		app, ok := applicability.(map[string]any)
		if !ok {
			t.Errorf("%s applicability is not an object", path)
			continue
		}
		requires, ok := app["requires_capabilities"].([]any)
		if !ok || len(requires) != 1 || requires[0] != "caller_cancellation" {
			t.Errorf("%s requires_capabilities = %v, want [caller_cancellation]", path, app["requires_capabilities"])
		}
		inapplicable, ok := app["inapplicable_languages"].([]any)
		if !ok || len(inapplicable) != 2 || inapplicable[0] != "php" || inapplicable[1] != "ruby" {
			t.Errorf("%s inapplicable_languages = %v, want [php ruby]", path, app["inapplicable_languages"])
			continue
		}
		for language := range languages {
			got := !caseAppliesToLanguage(fixture, language)
			want := language == "php" || language == "ruby"
			if got != want {
				t.Errorf("%s applicability for %s = inapplicable:%t, want %t from caller_cancellation capability table", path, language, got, want)
			}
		}
	}

	for path, fixture := range cases {
		if fixture["kind"] != "retry" {
			continue
		}
		client, _ := fixture["client"].(map[string]any)
		retryCount := float64(2)
		if configured, configuredOK := client["retry_count"].(float64); configuredOK {
			retryCount = configured
		}
		expect := fixtureExpect(fixture)
		attempts, attemptsOK := expect["attempts"].(float64)
		if !attemptsOK || attempts > retryCount+1 {
			t.Errorf("%s retry attempts = %v with effective retry_count %v, want attempts <= retry_count + 1", path, expect["attempts"], retryCount)
		}
	}
	defaultRetry := byID["retry-default-500-500-success"]
	if client, declared := defaultRetry["client"].(map[string]any); declared && client["retry_count"] != nil {
		t.Errorf("retry-default-500-500-success must leave client.retry_count absent")
	}
	if expect := fixtureExpect(defaultRetry); expect["attempts"] != float64(3) || !equalJSON(expect["jitter_bounds_ms"], []any{[]any{float64(0), float64(100)}, []any{float64(0), float64(200)}}) {
		t.Errorf("retry-default-500-500-success must prove the default two retries, three attempts, and jitter bounds")
	}

	for _, id := range []string{"success-bounded-multibyte-body", "error-bounded-multibyte-body"} {
		fixture := byID[id]
		recipe, ok := fixture["response_body_recipe"].(map[string]any)
		if !ok || recipe["unit"] != "€" || recipe["minimum_utf8_bytes"] != float64(65537) || recipe["suffix"] != "END" {
			t.Errorf("%s response_body_recipe = %v, want the exact bounded multibyte recipe", id, fixture["response_body_recipe"])
			continue
		}
		body := ""
		for len([]byte(body)) < 65537 {
			body += "€"
		}
		body += "END"
		retained := []byte(body)[:65536]
		expect, _ := fixture["expect"].(map[string]any)
		text := strings.ToValidUTF8(string(retained), "\uFFfd")
		if len(retained) != 65536 || retained[len(retained)-1] != 0xe2 || !strings.HasSuffix(text, "\uFFfd") || expect["retained_body_bytes"] != float64(65536) || expect["observed_body_bytes"] != float64(65537) || expect["body_truncated"] != true {
			t.Errorf("%s must prove 65,537 observed bytes, 65,536 retained bytes, truncation, and the UTF-8 split boundary", id)
		}
	}
}

func caseAppliesToLanguage(fixture map[string]any, language string) bool {
	applicability, declared := fixture["applicability"].(map[string]any)
	if !declared {
		return true
	}
	inapplicable, _ := applicability["inapplicable_languages"].([]any)
	for _, item := range inapplicable {
		if item == language {
			return false
		}
	}
	return true
}

func fixtureExpect(fixture map[string]any) map[string]any {
	expect, _ := fixture["expect"].(map[string]any)
	return expect
}

func fixtureResponses(fixture map[string]any) []any {
	responses, _ := fixture["responses"].([]any)
	return responses
}

func assertCanonicalResponse(t *testing.T, fixture map[string]any) {
	t.Helper()
	expect := fixtureExpect(fixture)
	if expect["result"] != "acknowledgement" || expect["attempts"] != float64(1) || expect["delivery_outcome_unknown"] != false {
		t.Errorf("success-valid has incorrect acknowledgement expectation: %v", expect)
	}
	responses := fixtureResponses(fixture)
	if len(responses) != 1 {
		t.Errorf("success-valid responses = %d, want 1", len(responses))
		return
	}
	response, _ := responses[0].(map[string]any)
	if response["status"] != float64(200) || response["body"] != `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}` {
		t.Errorf("success-valid must use the canonical success response")
	}
}

func assertMalformedSuccess(t *testing.T, id string, fixture map[string]any, wantBody string) {
	t.Helper()
	expect := fixtureExpect(fixture)
	responses := fixtureResponses(fixture)
	if expect["result"] != "response_decode_error" || expect["attempts"] != float64(1) || expect["delivery_outcome_unknown"] != false || len(responses) != 1 {
		t.Errorf("%s must expect one known-outcome response_decode_error", id)
		return
	}
	response, _ := responses[0].(map[string]any)
	if response["status"] != float64(200) || response["body"] != wantBody {
		t.Errorf("%s must contain its named malformed 200 shape", id)
	}
}

func assertStructuredHTTPError(t *testing.T, id string, fixture map[string]any, result string, status float64) {
	t.Helper()
	expect := fixtureExpect(fixture)
	if expect["result"] != result || expect["status"] != status || expect["error_message"] != "defined server error" || expect["server_error"] != "defined server error" || expect["server_code"] != "fixture_code" {
		t.Errorf("%s does not assert the typed structured HTTP error", id)
	}
	responses := fixtureResponses(fixture)
	if len(responses) != 1 {
		t.Errorf("%s responses = %d, want 1", id, len(responses))
		return
	}
	response, _ := responses[0].(map[string]any)
	if response["status"] != status || response["body"] != `{"success":false,"error":"defined server error","code":"fixture_code"}` {
		t.Errorf("%s does not use the structured error envelope", id)
	}
}

func assertMalformedHTTPError(t *testing.T, id string, fixture map[string]any, status float64, message string) {
	t.Helper()
	expect := fixtureExpect(fixture)
	if expect["result"] != "api_error" || expect["status"] != status || expect["error_message"] != message || expect["retained_body_bytes"] == nil {
		t.Errorf("%s must require api_error with the declared status, synthesized message, and bounded body", id)
	}
	if _, declared := expect["server_error"]; declared {
		t.Errorf("%s must not expose server_error for malformed non-200", id)
	}
	if _, declared := expect["server_code"]; declared {
		t.Errorf("%s must not expose server_code for malformed non-200", id)
	}
	responses := fixtureResponses(fixture)
	if len(responses) != 1 {
		t.Errorf("%s responses = %d, want 1", id, len(responses))
		return
	}
	response, _ := responses[0].(map[string]any)
	body, bodyOK := response["body"].(string)
	if response["status"] != status || !bodyOK || isErrorEnvelope(body) {
		t.Errorf("%s must contain a non-envelope body at status %v", id, status)
	}
}

func isErrorEnvelope(body string) bool {
	var envelope struct {
		Success any    `json:"success"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		return false
	}
	return envelope.Success == false && envelope.Error != ""
}

func assertRetrySemantics(t *testing.T, cases map[string]map[string]any) {
	t.Helper()
	canonicalSuccess := `{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}`
	structuredError := `{"success":false,"error":"defined server error","code":"fixture_code"}`
	disconnect := map[string]any{"body": "", "disconnect_before_headers": true}
	response := func(status float64, body string) map[string]any {
		return map[string]any{"status": status, "body": body}
	}
	for _, expected := range []struct {
		id        string
		responses []any
	}{
		{"retry-default-500-500-success", []any{response(500, structuredError), response(500, structuredError), response(200, canonicalSuccess)}},
		{"retry-500-500-success", []any{response(500, structuredError), response(500, structuredError), response(200, canonicalSuccess)}},
		{"retry-disconnect-disconnect-success", []any{disconnect, disconnect, response(200, canonicalSuccess)}},
		{"retry-timeout-timeout-success", []any{map[string]any{"status": float64(200), "body": canonicalSuccess, "delay_ms": float64(50)}, map[string]any{"status": float64(200), "body": canonicalSuccess, "delay_ms": float64(50)}, response(200, canonicalSuccess)}},
		{"retry-mixed-final-500", []any{disconnect, response(500, structuredError), response(500, structuredError)}},
		{"retry-mixed-final-transport", []any{response(500, structuredError), disconnect, disconnect}},
	} {
		fixture := cases[expected.id]
		expect := fixtureExpect(fixture)
		jitter, _ := expect["jitter_bounds_ms"].([]any)
		if expect["attempts"] != float64(3) || len(jitter) != 2 || !equalJSON(jitter, []any{[]any{float64(0), float64(100)}, []any{float64(0), float64(200)}}) {
			t.Errorf("%s must use three attempts and exact jitter bounds [[0,100],[0,200]]", expected.id)
		}
		if !equalJSON(fixtureResponses(fixture), expected.responses) {
			t.Errorf("%s must specify the complete ordered FIFO retry response sequence", expected.id)
		}
	}
	if fixtureExpect(cases["retry-mixed-final-500"])["result"] != "api_error" || fixtureExpect(cases["retry-mixed-final-transport"])["result"] != "transport_error" || fixtureExpect(cases["retry-mixed-final-transport"])["delivery_outcome_unknown"] != true {
		t.Errorf("mixed retry cases must expose their final failure type and certainty")
	}
	timeoutFixture := cases["retry-timeout-timeout-success"]
	client, _ := timeoutFixture["client"].(map[string]any)
	timeout, timeoutOK := client["timeout_ms"].(float64)
	if !timeoutOK || timeout != 25 {
		t.Errorf("retry-timeout-timeout-success timeout_ms = %v, want 25", client["timeout_ms"])
	}
	for i, item := range fixtureResponses(timeoutFixture)[:2] {
		response, _ := item.(map[string]any)
		if response["delay_ms"] == nil || response["delay_ms"].(float64) <= timeout {
			t.Errorf("retry-timeout-timeout-success response %d delay must exceed timeout_ms", i)
		}
	}
	for _, permanent := range []struct {
		id     string
		status float64
		body   string
	}{
		{"retry-no-400", 400, structuredError},
		{"retry-no-401", 401, structuredError},
		{"retry-no-404", 404, structuredError},
		{"retry-no-429", 429, "not an error envelope"},
	} {
		fixture := cases[permanent.id]
		if fixtureExpect(fixture)["attempts"] != float64(1) || !equalJSON(fixtureResponses(fixture), []any{response(permanent.status, permanent.body)}) {
			t.Errorf("%s must specify its permanent status as one non-retry FIFO response", permanent.id)
		}
	}
}

func equalJSON(got, want any) bool {
	gotJSON, gotErr := json.Marshal(got)
	wantJSON, wantErr := json.Marshal(want)
	return gotErr == nil && wantErr == nil && string(gotJSON) == string(wantJSON)
}

func assertCancellationSemantics(t *testing.T, cases map[string]map[string]any) {
	t.Helper()
	for id, phase := range map[string]string{
		"cancellation-before-request": "before_request",
		"cancellation-during-request": "during_request",
		"cancellation-during-backoff": "during_backoff",
	} {
		fixture := cases[id]
		cancellation, _ := fixture["cancellation"].(map[string]any)
		expect := fixtureExpect(fixture)
		if cancellation["phase"] != phase || expect["result"] != "caller_cancelled" {
			t.Errorf("%s must assert caller cancellation during %s", id, phase)
		}
	}
	if fixtureExpect(cases["cancellation-before-request"])["attempts"] != float64(0) || fixtureExpect(cases["cancellation-during-request"])["attempts"] != float64(1) || fixtureExpect(cases["cancellation-during-backoff"])["attempts"] != float64(1) {
		t.Errorf("cancellation attempts must be 0 before request and 1 during request/backoff")
	}
	responses := fixtureResponses(cases["cancellation-during-request"])
	if len(responses) != 1 || func() any { response, _ := responses[0].(map[string]any); return response["delay_ms"] }() == nil {
		t.Errorf("cancellation-during-request must include one delayed journaled response")
	}
	responses = fixtureResponses(cases["cancellation-during-backoff"])
	if len(responses) != 1 || func() any { response, _ := responses[0].(map[string]any); return response["status"] }() != float64(500) {
		t.Errorf("cancellation-during-backoff must include one completed 500 response")
	}
}

func TestValidationPropertiesRecipes(t *testing.T) {
	want := []string{"cycle", "nan", "negative_infinity", "non_string_key", "positive_infinity", "runtime_object", "unsafe_integer_high", "unsafe_integer_low"}
	seen := make(map[string]int)
	for path, fixture := range loadCases(t) {
		if fixture["kind"] != "validation" {
			continue
		}
		expect, ok := fixture["expect"].(map[string]any)
		if !ok {
			t.Errorf("%s expect is not an object", path)
		} else {
			if expect["result"] != "validation_error" || expect["attempts"] != float64(0) {
				t.Errorf("%s must expect validation_error with zero attempts", path)
			}
			if _, hasRequest := expect["request"]; hasRequest {
				t.Errorf("%s local validation case must not expect a request", path)
			}
		}

		operation, ok := fixture["operation"].(map[string]any)
		if !ok {
			t.Errorf("%s operation is not an object", path)
			continue
		}
		if recipe, ok := operation["properties_recipe"].(string); ok {
			seen[recipe]++
		}
	}

	var got []string
	for recipe, count := range seen {
		got = append(got, recipe)
		if count != 1 {
			t.Errorf("properties recipe %q occurs %d times, want exactly once", recipe, count)
		}
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("validation properties recipes = %v, want %v", got, want)
	}
}
