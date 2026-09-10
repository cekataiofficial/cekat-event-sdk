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

func newSchemaCompiler(t *testing.T) *jsonschema.Compiler {
	t.Helper()

	compiler := jsonschema.NewCompiler()
	for _, resourceName := range schemaFiles {
		path := filepath.Join("..", "..", "..", "fixtures", "schemas", resourceName)
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

func TestSchemasCompile(t *testing.T) {
	for _, filename := range schemaFiles {
		t.Run(filename, func(t *testing.T) {
			compiler := jsonschema.NewCompiler()
			var targetURI string

			for _, resourceName := range schemaFiles {
				path := filepath.Join("..", "..", "..", "fixtures", "schemas", resourceName)
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("read %s: %v", resourceName, err)
				}

				var document map[string]any
				if err := json.Unmarshal(data, &document); err != nil {
					t.Fatalf("decode %s: %v", resourceName, err)
				}
				if got := document["$schema"]; got != draft202012 {
					t.Errorf("%s $schema = %v, want %q", resourceName, got, draft202012)
				}
				wantID := schemaIDBase + resourceName
				if got := document["$id"]; got != wantID {
					t.Errorf("%s $id = %v, want %q", resourceName, got, wantID)
				}

				uri := fmt.Sprintf("file://%s", path)
				if err := compiler.AddResource(uri, document); err != nil {
					t.Fatalf("add file URI for %s: %v", resourceName, err)
				}
				if err := compiler.AddResource(wantID, document); err != nil {
					t.Fatalf("add canonical URI for %s: %v", resourceName, err)
				}
				if resourceName == filename {
					targetURI = uri
				}
			}

			if _, err := compiler.Compile(targetURI); err != nil {
				t.Fatalf("compile %s: %v", filename, err)
			}
		})
	}
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
