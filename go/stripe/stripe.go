package stripe

import (
	"context"
	"strings"

	cekat "golang.cekat.ai/event-sdk"
)

const visitorMetadataKey = "cekat_visitor_id"

func MetadataForVisitor(visitorID string) map[string]string {
	visitorID, ok := validVisitorID(visitorID)
	if !ok {
		return map[string]string{}
	}
	return map[string]string{visitorMetadataKey: visitorID}
}

func MetadataFromContext(ctx context.Context) map[string]string {
	visitorID, ok := cekat.VisitorIDFromContext(ctx)
	if !ok {
		return map[string]string{}
	}
	return MetadataForVisitor(visitorID)
}

func MergeMetadata(metadata map[string]string, visitorID string) map[string]string {
	merged := make(map[string]string, len(metadata)+1)
	for key, value := range metadata {
		merged[key] = value
	}
	if normalizedVisitorID, ok := validVisitorID(visitorID); ok {
		merged[visitorMetadataKey] = normalizedVisitorID
	}
	return merged
}

func validVisitorID(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > 128 {
		return "", false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '_' && character != '-' {
			return "", false
		}
	}
	return value, true
}
