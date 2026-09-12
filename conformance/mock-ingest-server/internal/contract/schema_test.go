package contract

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	draft202012  = "https://json-schema.org/draft/2020-12/schema"
	schemaIDBase = "https://schemas.cekat.ai/event-sdk/conformance/"
)

var schemaFiles = []string{
	"json-value.schema.json",
	"event-payload.schema.json",
	"success-envelope.schema.json",
	"error-envelope.schema.json",
	"mock-response-queue.schema.json",
	"request-journal.schema.json",
	"conformance-case.schema.json",
}

func schemaDirectory() string {
	return filepath.Join("..", "..", "..", "fixtures", "schemas")
}

func discoverSchemaFiles(dir string) ([]string, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.schema.json"))
	if err != nil {
		return nil, fmt.Errorf("discover schemas: %w", err)
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("discover schemas: no direct *.schema.json files in %s", dir)
	}
	files := make([]string, len(paths))
	for i, path := range paths {
		files[i] = filepath.Base(path)
	}
	return files, nil
}

func compileSchemas(dir string) error {
	files, err := discoverSchemaFiles(dir)
	if err != nil {
		return err
	}
	compiler := jsonschema.NewCompiler()
	for _, resourceName := range files {
		path := filepath.Join(dir, resourceName)
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", resourceName, err)
		}
		var document map[string]any
		if err := json.Unmarshal(data, &document); err != nil {
			return fmt.Errorf("decode %s: %w", resourceName, err)
		}
		if got := document["$schema"]; got != draft202012 {
			return fmt.Errorf("%s $schema = %v, want %q", resourceName, got, draft202012)
		}
		wantID := schemaIDBase + resourceName
		if got := document["$id"]; got != wantID {
			return fmt.Errorf("%s $id = %v, want %q", resourceName, got, wantID)
		}
		uri := fmt.Sprintf("file://%s", path)
		if err := compiler.AddResource(uri, document); err != nil {
			return fmt.Errorf("add file URI for %s: %w", resourceName, err)
		}
		if err := compiler.AddResource(wantID, document); err != nil {
			return fmt.Errorf("add canonical URI for %s: %w", resourceName, err)
		}
	}
	for _, resourceName := range files {
		if _, err := compiler.Compile(fmt.Sprintf("file://%s", filepath.Join(dir, resourceName))); err != nil {
			return fmt.Errorf("compile %s: %w", resourceName, err)
		}
	}
	return nil
}

func newSchemaCompiler(t *testing.T) *jsonschema.Compiler {
	t.Helper()

	files, err := discoverSchemaFiles(schemaDirectory())
	if err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	for _, resourceName := range files {
		path := filepath.Join(schemaDirectory(), resourceName)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", resourceName, err)
		}
		var document map[string]any
		if err := json.Unmarshal(data, &document); err != nil {
			t.Fatalf("decode %s: %v", resourceName, err)
		}
		uri := fmt.Sprintf("file://%s", path)
		if err := compiler.AddResource(uri, document); err != nil {
			t.Fatalf("add file URI for %s: %v", resourceName, err)
		}
		if err := compiler.AddResource(schemaIDBase+resourceName, document); err != nil {
			t.Fatalf("add canonical URI for %s: %v", resourceName, err)
		}
	}
	return compiler
}

func TestSchemaDiscoveryMutation(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "new-malformed.schema.json"), []byte(`{"$schema":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := compileSchemas(dir); err == nil {
		t.Fatal("malformed newly discovered schema unexpectedly compiled")
	}
}

func TestSchemasCompile(t *testing.T) {
	files, err := discoverSchemaFiles(schemaDirectory())
	if err != nil {
		t.Fatal(err)
	}
	if err := compileSchemas(schemaDirectory()); err != nil {
		t.Fatal(err)
	}
	if !equalStringSets(files, schemaFiles) {
		t.Fatalf("discovered schema files = %v, want closed contract set %v", files, schemaFiles)
	}
}

func equalStringSets(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	seen := make(map[string]bool, len(got))
	for _, item := range got {
		seen[item] = true
	}
	for _, item := range want {
		if !seen[item] {
			return false
		}
	}
	return true
}

func TestCasesValidate(t *testing.T) {
	compiler := newSchemaCompiler(t)
	schema, err := compiler.Compile(schemaIDBase + "conformance-case.schema.json")
	if err != nil {
		t.Fatalf("compile conformance case schema: %v", err)
	}

	cases := loadCases(t)
	for path, fixture := range cases {
		t.Run(filepath.Base(path), func(t *testing.T) {
			if err := schema.Validate(fixture); err != nil {
				t.Fatalf("validate %s: %v", path, err)
			}
		})
	}
}
