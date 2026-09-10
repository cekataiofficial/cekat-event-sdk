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
	if len(cases) != 21 {
		t.Errorf("discovered %d request and validation cases, want 21", len(cases))
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
