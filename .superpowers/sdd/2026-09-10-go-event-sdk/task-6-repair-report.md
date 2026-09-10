# Task 6 P1 Repair Report — Representable Retry Attempts

## Status

Repaired the remaining Task 6 P1: `WithRetryCount(math.MaxInt)` is rejected during `New` configuration validation because its required final attempt cannot be represented in public `int` `Attempts` metadata.

## TDD Evidence

### RED

The focused boundary regression was added before the production counter policy:

```bash
cd go && go test . -run 'Test(NewRejectsInvalidConfiguration|RetryCountAttemptBounds)' -count=1
```

It failed to build because the new boundary test referenced the not-yet-implemented `retryAttempts` counter-policy seam:

```text
./retry_test.go:137:16: undefined: retryAttempts
./retry_test.go:140:14: undefined: retryAttempts
FAIL
```

### GREEN

`retryAttempts` now validates the total attempt count before calculating it. It allows `math.MaxInt-1` retries, whose final attempt is exactly `math.MaxInt`, and rejects `math.MaxInt` retries without performing overflowing arithmetic. `validateConfig` applies this policy during `New`, returning `*ValidationError` with the safe bound stated generically and without configuration/token data.

The delivery loop consumes the same seam to make the representable loop limit explicit; it has no saturating or duplicate attempt metadata behavior.

## Scope

Only retry-count configuration validation, its private counter-policy seam, delivery-loop bound, and boundary tests changed. Existing saturated backoff and redirect containment behavior remains unchanged. No middleware or adapters were added.

## Verification

Passed:

```bash
cd go
gofmt -w client.go options.go options_test.go retry.go retry_test.go
go test . -run 'Test(NewRejectsInvalidConfiguration|RetryCountAttemptBounds)' -count=1
go test . -count=1
go test -race . -count=1
go vet .
go build .
cd ..
git diff --check
```

## Residual Risks

The allowed `math.MaxInt-1` setting is intentionally not dispatched in an integration test: executing that many requests is impractical. The extracted pure counter-policy test verifies its exact arithmetic boundary instead.
