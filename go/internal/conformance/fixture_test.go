package conformance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadFixturesRejectsSchemaInvalidForms(t *testing.T) {
	sharedCases := filepath.Join("..", "..", "..", "conformance", "fixtures", "cases")
	sharedSchemas, err := filepath.Abs(filepath.Join("..", "..", "..", "conformance", "fixtures", "schemas"))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		fixture string
		mutate  func(string) string
	}{
		{"body recipe requires all expectations", "success-bounded-multibyte-body.json", func(source string) string { return strings.Replace(source, `"observed_body_bytes": 65537,`, "", 1) }},
		{"acknowledgement success must be true", "success-valid.json", func(source string) string { return strings.Replace(source, `"success": true,`, `"success": false,`, 1) }},
		{"disconnect delay must be nonnegative", "retry-disconnect-disconnect-success.json", func(source string) string {
			return strings.Replace(source, `"disconnect_before_headers": true`, `"delay_ms": -1, "disconnect_before_headers": true`, 1)
		}},
		{"null typed field rejected", "success-valid.json", func(source string) string {
			return strings.Replace(source, `"acknowledgement": {`, `"acknowledgement": null,`, 1)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			directory := filepath.Join(root, "cases")
			if err := os.Mkdir(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(sharedSchemas, filepath.Join(root, "schemas")); err != nil {
				t.Fatal(err)
			}
			source := readFixture(t, filepath.Join(sharedCases, test.fixture))
			if err := os.WriteFile(filepath.Join(directory, strings.TrimSuffix(test.fixture, ".json")+".json"), []byte(test.mutate(source)), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadFixtures(directory); err == nil {
				t.Fatal("loadFixtures accepted schema-invalid fixture")
			}
		})
	}
}

func readFixture(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
