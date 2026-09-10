# Task 2 Report: Go Models, Options, and Typed Errors

## Status

Completed Task 2 and committed it as `fa5ba4a feat(go): add public models options and errors`.

## Scope

Created the Task 2 public models (`Event`, `Acknowledgement`, `Client`), `New` and its four options, default/final option validation, and the six concrete pointer-matchable typed errors. This task does not implement event-input validation, payload construction, HTTP delivery, retries, response parsing, context propagation, adapters, or public event-operation methods.

The direct task text also asked for strict local event validation and recursive JSON-domain validation. That conflicts with the binding approved Task 2 brief and plan, which explicitly allocate that work to Task 3 (`validation.go`, `validation_test.go`, `client.go`, and `client_test.go`). Per supervisor direction, it was deferred to Task 3.

## TDD evidence

### RED

After first adding only the Task 2 tests, before production files existed:

```text
$ cd go && go test . -run 'Test(New|Options|TypedErrors)' -count=1
# github.com/cekataiofficial/cekat-event-sdk-go [github.com/cekataiofficial/cekat-event-sdk-go.test]
./errors_test.go:21:11: undefined: ValidationError
./errors_test.go:24:16: undefined: ValidationError
./errors_test.go:32:11: undefined: AuthenticationError
./errors_test.go:35:16: undefined: AuthenticationError
./errors_test.go:43:11: undefined: EventDefinitionNotFoundError
./errors_test.go:46:16: undefined: EventDefinitionNotFoundError
./errors_test.go:54:11: undefined: ApiError
./errors_test.go:57:16: undefined: ApiError
./errors_test.go:65:13: undefined: TransportError
./errors_test.go:77:13: undefined: ResponseDecodeError
FAIL	github.com/cekataiofficial/cekat-event-sdk-go [build failed]
FAIL
```

The expected missing Task 2 public types caused the failing test build.

### GREEN

`options_test.go` covers documented defaults, blank-token redaction, every invalid base-URL form required by the plan, zero/negative timeout, negative retry count, nil HTTP client, option/final-config error normalization to `*ValidationError`, trailing-slash normalization, and injected-client retention without mutation.

`errors_test.go` covers all six pointer error types with `errors.As`, public field retention, `Unwrap`/`errors.Is` for transport and decode errors, and retained response-body contents. It does not establish response-body aliasing defense; ownership must be enforced at the Task 5 response-body capture seam.

## Files

Committed source and tests:

- `go/event.go`
- `go/options.go`
- `go/options_test.go`
- `go/errors.go`
- `go/errors_test.go`

## Verification

```text
$ cd go && gofmt -w event.go options.go options_test.go errors.go errors_test.go && go test . -run 'Test(New|Options|TypedErrors)' -count=1
ok  	github.com/cekataiofficial/cekat-event-sdk-go

$ cd go && go test . -count=1 && go vet .
ok  	github.com/cekataiofficial/cekat-event-sdk-go

$ git diff --check
(exit 0)
```

## Risks

- Event identity checks and recursive interoperable JSON-property validation are deliberately absent until Task 3, as specified by the approved plan.
- Response-body ownership at the point of HTTP buffer capture belongs to Task 5 response decoding. Task 2 exposes the required `Body []byte` fields and verifies their retained contents; it does not create an unplanned error-construction API.
