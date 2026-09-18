package stripe

import (
	"context"
	"strings"
	"testing"

	cekat "golang.cekat.ai/event-sdk"
)

func TestMetadataForVisitor(t *testing.T) {
	for _, test := range []struct {
		name  string
		input string
		want  string
	}{
		{name: "trims", input: " visitor_A-1 ", want: "visitor_A-1"},
		{name: "minimum length", input: "a", want: "a"},
		{name: "maximum length", input: strings.Repeat("a", 128), want: strings.Repeat("a", 128)},
		{name: "too long", input: strings.Repeat("a", 129)},
		{name: "invalid character", input: "visitor value"},
		{name: "blank", input: " \t "},
	} {
		t.Run(test.name, func(t *testing.T) {
			metadata := MetadataForVisitor(test.input)
			if test.want == "" {
				if len(metadata) != 0 {
					t.Fatalf("MetadataForVisitor(%q) = %#v, want empty", test.input, metadata)
				}
				return
			}
			if got := metadata["cekat_visitor_id"]; got != test.want {
				t.Fatalf("MetadataForVisitor(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestMetadataFromContextAndMergeMetadata(t *testing.T) {
	ctx := cekat.WithVisitorID(context.Background(), " scoped_visitor ")
	fromContext := MetadataFromContext(ctx)
	if got := fromContext["cekat_visitor_id"]; got != "scoped_visitor" {
		t.Fatalf("MetadataFromContext() = %q", got)
	}
	if metadata := MetadataFromContext(context.Background()); len(metadata) != 0 {
		t.Fatalf("MetadataFromContext(empty) = %#v, want empty", metadata)
	}

	original := map[string]string{"merchant": "keep", "cekat_visitor_id": "replace"}
	merged := MergeMetadata(original, " visitor_2 ")
	if merged["merchant"] != "keep" || merged["cekat_visitor_id"] != "visitor_2" {
		t.Fatalf("MergeMetadata() = %#v", merged)
	}
	if original["cekat_visitor_id"] != "replace" {
		t.Fatalf("MergeMetadata mutated original: %#v", original)
	}
	merged["merchant"] = "changed"
	if original["merchant"] != "keep" {
		t.Fatalf("merged collection aliases original: %#v", original)
	}
	unchanged := MergeMetadata(original, "invalid value")
	if unchanged["cekat_visitor_id"] != "replace" || len(unchanged) != len(original) {
		t.Fatalf("invalid merge = %#v", unchanged)
	}
}
