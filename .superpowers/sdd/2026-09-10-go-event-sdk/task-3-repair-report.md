# Task 3 P1 Repair Report — Canonical Property JSON

Status: DONE

## Scope

Repairs only the two P1 findings from `task-3-review.md`. No public wrappers, delivery/retry behavior, visitor/context work, response decoding, adapters, or RoundTripper integration were added; the latter remains Task 6 work.

## TDD Evidence

### RED

After adding the focused regression cases and before changing implementation:

```bash
cd go && go test ./...
```

Failed as intended:

- `TestValidateEvent/unsafe_positive_integral_float` and `unsafe_negative_integral_float` accepted unsafe integral `float64` values.
- `TestBuildPayloadNormalizesPropertiesForJSON` preserved `[]byte` as `[]uint8`, which `encoding/json` encodes as base64 rather than a JSON array.

### GREEN

```bash
cd go
go test . -run 'Test(ValidateEvent|BuildPayload|Operations)' -count=1
go test . -run=^$ -fuzz=FuzzValidateProperties -fuzztime=10s
go test ./... -count=1
go build ./...
go test -race ./... -count=1
go vet ./...
cd ..
git diff --check
```

All commands passed. The 10-second fuzz run completed 1,561,965 executions without a panic, mutation, or value leak.

## Changes

- Finite floats that are mathematically integral outside `[-9007199254740991, 9007199254740991]` are now rejected, including exact positive and negative `9007199254740992` values.
- Validated properties are recursively copied into canonical built-in values: `bool`, `string`, `int64`, `float64`, `[]any`, and `map[string]any` (with `nil` retained for JSON null).
- This intentionally accepts `[]byte` as a normal byte slice and normalizes it to a JSON number array. `json.RawMessage` is likewise normalized to its byte array, not treated as raw JSON. Named `json.Marshaler` scalar/container types are reduced by kind before encoding, so their custom marshaling cannot alter the wire value.
- Marshal-based tests cover those Go-specific encoding hazards and named scalar/container semantics.

## Changed Files

- `go/validation.go`
- `go/validation_test.go`
- `.superpowers/sdd/2026-09-10-go-event-sdk/task-3-repair-report.md`

## Residual Risks

None within Task 3 validation and payload-copy scope. Task 6 must add the actual operation-to-delivery path and then prove validation prevents RoundTripper calls end-to-end.
