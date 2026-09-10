# Task 2 Repair Report: Reject Port-Only Base URL Authorities

## Status

Repaired Task 2 P1: `WithBaseURL("https://:443")` is now rejected by `New` with `*ValidationError`.

## TDD Evidence

### RED

After adding the `port-only URL authority` case to `TestNewRejectsInvalidConfiguration`, before changing production code:

```text
$ cd go && go test . -run '^TestNewRejectsInvalidConfiguration$/port-only_URL_authority$' -count=1
--- FAIL: TestNewRejectsInvalidConfiguration (0.00s)
    --- FAIL: TestNewRejectsInvalidConfiguration/port-only_URL_authority (0.00s)
        options_test.go:69: New() client = ..., want nil
FAIL
```

### GREEN

`parseBaseURL` now requires both a nonempty URL authority and `parsed.Hostname() != ""`. This rejects a port-only authority while preserving the existing allowed origin forms.

## Scope

Only Task 2 P1 base-origin validation and its regression test were changed. No Task 3 or later behavior was implemented.

The existing Task 2 error-body test verifies retained `Body` contents only. It does not establish defensive-copy/aliasing behavior; that response-buffer ownership belongs at the Task 5 response-decoding capture seam.

## Verification

- Focused regression test: passed after the fix.
- Package tests, vet, race detector, and whitespace-diff check: passed.
