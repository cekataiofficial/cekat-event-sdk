package cekat

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	maxSafeInteger   int64 = 9007199254740991
	occurredAtLayout       = "2006-01-02T15:04:05.000Z"
)

// validateEvent applies the stable event rules before any delivery is attempted.
func validateEvent(eventKey string, event Event) error {
	if strings.TrimSpace(eventKey) == "" {
		return &ValidationError{Message: "event key must not be blank"}
	}
	if strings.TrimSpace(event.Email) == "" && strings.TrimSpace(event.PhoneNumber) == "" {
		return &ValidationError{Message: "event must include a non-blank email or phone number"}
	}
	if !event.OccurredAt.IsZero() {
		if year := event.OccurredAt.UTC().Year(); year < 1 || year > 9999 {
			return &ValidationError{Message: "occurred at must be between years 0001 and 9999"}
		}
	}
	return nil
}

// normalizeProperties encodes properties with encoding/json so values use their
// standard JSON representation, then verifies the result is portable JSON. The
// returned map snapshots the caller's values at call time.
func normalizeProperties(properties map[string]any) (map[string]any, error) {
	if properties == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(properties)
	if err != nil {
		return nil, &ValidationError{Message: "properties is not a JSON-compatible value: " + err.Error()}
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var normalized map[string]any
	if err := decoder.Decode(&normalized); err != nil {
		return nil, &ValidationError{Message: "properties is not a JSON-compatible value: " + err.Error()}
	}
	for key, value := range normalized {
		if err := validatePortableJSON(value, propertyPath("properties", key)); err != nil {
			return nil, err
		}
	}
	return normalized, nil
}

// validatePortableJSON rejects numbers that other JSON implementations cannot
// represent exactly. Decoded values are only json.Number, strings, booleans, nil,
// []any, and map[string]any.
func validatePortableJSON(value any, path string) error {
	switch typed := value.(type) {
	case json.Number:
		if !portableNumber(typed.String()) {
			return invalidJSONValue(path)
		}
	case []any:
		for index, item := range typed {
			if err := validatePortableJSON(item, fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
		}
	case map[string]any:
		for key, item := range typed {
			if err := validatePortableJSON(item, propertyPath(path, key)); err != nil {
				return err
			}
		}
	}
	return nil
}

func portableNumber(literal string) bool {
	if !strings.ContainsAny(literal, ".eE") {
		number, err := strconv.ParseInt(literal, 10, 64)
		return err == nil && number >= -maxSafeInteger && number <= maxSafeInteger
	}
	number, err := strconv.ParseFloat(literal, 64)
	if err != nil || math.IsInf(number, 0) || math.IsNaN(number) {
		return false
	}
	return number != math.Trunc(number) || math.Abs(number) <= float64(maxSafeInteger)
}

func invalidJSONValue(path string) error {
	return &ValidationError{Message: path + " is not a JSON-compatible value"}
}

func propertyPath(parent, key string) string {
	if key == "" {
		return parent + `[""]`
	}
	return parent + "." + key
}

// withOrderPaidProperties returns a copy of event whose properties include the
// required order_paid arguments. The caller's properties map is not mutated.
func withOrderPaidProperties(amount float64, currency string, event Event) (Event, error) {
	if math.IsNaN(amount) || math.IsInf(amount, 0) {
		return Event{}, &ValidationError{Message: "amount must be a finite number"}
	}
	if strings.TrimSpace(currency) == "" {
		return Event{}, &ValidationError{Message: "currency must not be blank"}
	}
	properties := make(map[string]any, len(event.Properties)+2)
	for key, value := range event.Properties {
		if key == "amount" || key == "currency" {
			return Event{}, &ValidationError{Message: "properties must not contain " + strconv.Quote(key) + "; pass it as the OrderPaid argument"}
		}
		properties[key] = value
	}
	properties["amount"] = amount
	properties["currency"] = currency
	event.Properties = properties
	return event, nil
}

func buildPayload(ctx context.Context, eventKey string, isCommon bool, event Event) (wirePayload, error) {
	if err := validateEvent(eventKey, event); err != nil {
		return wirePayload{}, err
	}

	properties, err := normalizeProperties(event.Properties)
	if err != nil {
		return wirePayload{}, err
	}
	visitorID := strings.TrimSpace(event.VisitorID)
	if visitorID == "" {
		visitorID, _ = VisitorIDFromContext(ctx)
	}
	eventID := strings.TrimSpace(event.EventID)
	if eventID == "" {
		eventID = newEventID()
	}
	occurredAt := event.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = time.Now()
	}

	return wirePayload{
		EventKey:    eventKey,
		EventID:     eventID,
		OccurredAt:  occurredAt.UTC().Format(occurredAtLayout),
		ContactName: event.ContactName,
		PhoneNumber: event.PhoneNumber,
		Email:       event.Email,
		VisitorID:   visitorID,
		IsCommon:    isCommon,
		Properties:  properties,
	}, nil
}

// newEventID returns a lowercase random (version 4) UUID.
func newEventID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic("cekat: crypto/rand failed: " + err.Error())
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	var text [36]byte
	hex.Encode(text[0:8], id[0:4])
	text[8] = '-'
	hex.Encode(text[9:13], id[4:6])
	text[13] = '-'
	hex.Encode(text[14:18], id[6:8])
	text[18] = '-'
	hex.Encode(text[19:23], id[8:10])
	text[23] = '-'
	hex.Encode(text[24:], id[10:])
	return string(text[:])
}
