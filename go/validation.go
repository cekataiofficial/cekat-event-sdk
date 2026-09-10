package cekat

import (
	"context"
	"fmt"
	"math"
	"reflect"
	"strings"
)

const maxSafeInteger int64 = 9007199254740991

// validateEvent applies the stable event rules before any delivery is attempted.
func validateEvent(eventKey string, event Event) error {
	if strings.TrimSpace(eventKey) == "" {
		return &ValidationError{Message: "event key must not be blank"}
	}
	if strings.TrimSpace(event.Email) == "" && strings.TrimSpace(event.PhoneNumber) == "" {
		return &ValidationError{Message: "event must include a non-blank email or phone number"}
	}
	if err := validateProperties(event.Properties); err != nil {
		return err
	}
	return nil
}

func validateProperties(properties map[string]any) error {
	if properties == nil {
		return nil
	}
	return validateJSONValue(reflect.ValueOf(properties), "properties", make(map[visit]struct{}))
}

type visit struct {
	typ reflect.Type
	ptr uintptr
}

func validateJSONValue(value reflect.Value, path string, ancestors map[visit]struct{}) error {
	if !value.IsValid() {
		return nil
	}

	switch value.Kind() {
	case reflect.Interface:
		if value.IsNil() {
			return nil
		}
		return validateJSONValue(value.Elem(), path, ancestors)
	case reflect.Bool, reflect.String:
		return nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if isUnsafeInteger(value.Int()) {
			return invalidJSONValue(path)
		}
		return nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		if value.Uint() > uint64(maxSafeInteger) {
			return invalidJSONValue(path)
		}
		return nil
	case reflect.Float32, reflect.Float64:
		number := value.Float()
		if math.IsNaN(number) || math.IsInf(number, 0) || (number == math.Trunc(number) && (number < -float64(maxSafeInteger) || number > float64(maxSafeInteger))) {
			return invalidJSONValue(path)
		}
		return nil
	case reflect.Map:
		if value.IsNil() {
			return nil
		}
		if value.Type().Key().Kind() != reflect.String {
			return invalidJSONValue(path)
		}
		return withContainer(value, path, ancestors, func() error {
			iter := value.MapRange()
			for iter.Next() {
				if err := validateJSONValue(iter.Value(), propertyPath(path, iter.Key().String()), ancestors); err != nil {
					return err
				}
			}
			return nil
		})
	case reflect.Slice:
		if value.IsNil() {
			return nil
		}
		return withContainer(value, path, ancestors, func() error {
			for index := 0; index < value.Len(); index++ {
				if err := validateJSONValue(value.Index(index), fmt.Sprintf("%s[%d]", path, index), ancestors); err != nil {
					return err
				}
			}
			return nil
		})
	case reflect.Array:
		for index := 0; index < value.Len(); index++ {
			if err := validateJSONValue(value.Index(index), fmt.Sprintf("%s[%d]", path, index), ancestors); err != nil {
				return err
			}
		}
		return nil
	default:
		return invalidJSONValue(path)
	}
}

func withContainer(value reflect.Value, path string, ancestors map[visit]struct{}, validate func() error) error {
	identity := visit{typ: value.Type(), ptr: value.Pointer()}
	if _, seen := ancestors[identity]; seen {
		return &ValidationError{Message: path + " contains a cycle"}
	}
	ancestors[identity] = struct{}{}
	defer delete(ancestors, identity)
	return validate()
}

func isUnsafeInteger(number int64) bool {
	return number < -maxSafeInteger || number > maxSafeInteger
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

func buildPayload(ctx context.Context, eventKey string, isCommon bool, event Event) (wirePayload, error) {
	if err := validateEvent(eventKey, event); err != nil {
		return wirePayload{}, err
	}

	properties, err := copyProperties(event.Properties)
	if err != nil {
		return wirePayload{}, err
	}
	visitorID := strings.TrimSpace(event.VisitorID)
	if visitorID == "" {
		visitorID, _ = VisitorIDFromContext(ctx)
	}

	return wirePayload{
		EventKey:    eventKey,
		ContactName: event.ContactName,
		PhoneNumber: event.PhoneNumber,
		Email:       event.Email,
		VisitorID:   visitorID,
		IsCommon:    isCommon,
		Properties:  properties,
	}, nil
}

func copyProperties(properties map[string]any) (map[string]any, error) {
	if properties == nil {
		return nil, nil
	}
	copied, err := copyJSONValue(reflect.ValueOf(properties), make(map[visit]struct{}))
	if err != nil {
		return nil, err
	}
	return copied.(map[string]any), nil
}

// copyJSONValue converts validated values to built-in types so encoding/json cannot
// apply named-type or []byte-specific serialization rules.
func copyJSONValue(value reflect.Value, ancestors map[visit]struct{}) (any, error) {
	if !value.IsValid() {
		return nil, nil
	}
	if value.Kind() == reflect.Interface {
		if value.IsNil() {
			return nil, nil
		}
		return copyJSONValue(value.Elem(), ancestors)
	}

	switch value.Kind() {
	case reflect.Bool:
		return value.Bool(), nil
	case reflect.String:
		return value.String(), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return value.Int(), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return int64(value.Uint()), nil
	case reflect.Float32, reflect.Float64:
		return value.Float(), nil
	case reflect.Map:
		if value.IsNil() {
			return nil, nil
		}
		identity := visit{typ: value.Type(), ptr: value.Pointer()}
		if _, seen := ancestors[identity]; seen {
			return nil, &ValidationError{Message: "properties contains a cycle"}
		}
		ancestors[identity] = struct{}{}
		defer delete(ancestors, identity)
		copied := make(map[string]any, value.Len())
		iter := value.MapRange()
		for iter.Next() {
			entry, err := copyJSONValue(iter.Value(), ancestors)
			if err != nil {
				return nil, err
			}
			copied[iter.Key().String()] = entry
		}
		return copied, nil
	case reflect.Slice:
		if value.IsNil() {
			return nil, nil
		}
		identity := visit{typ: value.Type(), ptr: value.Pointer()}
		if _, seen := ancestors[identity]; seen {
			return nil, &ValidationError{Message: "properties contains a cycle"}
		}
		ancestors[identity] = struct{}{}
		defer delete(ancestors, identity)
		copied := make([]any, value.Len())
		for index := 0; index < value.Len(); index++ {
			entry, err := copyJSONValue(value.Index(index), ancestors)
			if err != nil {
				return nil, err
			}
			copied[index] = entry
		}
		return copied, nil
	case reflect.Array:
		copied := make([]any, value.Len())
		for index := 0; index < value.Len(); index++ {
			entry, err := copyJSONValue(value.Index(index), ancestors)
			if err != nil {
				return nil, err
			}
			copied[index] = entry
		}
		return copied, nil
	default:
		return nil, invalidJSONValue("properties")
	}
}
