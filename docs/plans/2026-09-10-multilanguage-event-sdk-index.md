# Multilanguage Event SDK Execution Plan Index

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).



> **For agentic workers:** Use `superpowers:subagent-driven-development` to execute these plans task-by-task. Do not begin implementation until the plans are reviewed and approved.

**Goal:** Execute the approved contract-first SDK design across one shared conformance implementation, seven independently releasable language packages, and a final CI/release-readiness consumer.

**Authoritative design:** `../specs/2026-09-10-multilanguage-event-sdk-design.md`

## Plan Order

1. [Shared protocol and conformance](2026-09-10-shared-conformance.md)
2. [Go SDK](2026-09-10-go-event-sdk.md)
3. [Node.js and browser SDK](2026-09-10-node-browser-event-sdk.md)
4. [Python SDK](2026-09-10-python-event-sdk.md)
5. [PHP SDK](2026-09-10-php-event-sdk.md)
6. [Java SDK](2026-09-10-java-event-sdk.md)
7. [.NET SDK](2026-09-10-dotnet-event-sdk.md)
8. [Ruby SDK](2026-09-10-ruby-event-sdk.md)
9. [Cross-language CI and release readiness](2026-09-10-cross-language-ci-release.md)

## Ownership and Dependencies

- The [shared protocol and conformance plan](2026-09-10-shared-conformance.md) exclusively owns `conformance/fixtures/schemas/*.schema.json`, every per-case file under `conformance/fixtures/cases/`, `conformance/README.md`, and the Go module under `conformance/mock-ingest-server/`.
- No language plan and no CI/release plan may recreate, regroup, overwrite, or fork those shared artifacts. They consume them by the exact paths above.
- A language plan may execute independently after the shared plan exists. Each language owns its SDK, framework tests, compatibility evidence, documentation, and its two stable executable entrypoints: `<language>/scripts/conformance` and `<language>/scripts/package`.
- The stable runner contract in this index and `2026-09-10-shared-conformance.md` is authoritative over any stale environment-variable name, default URL, fixture list, mock launch command, or package-schema shorthand in a language plan. Implementers must apply the exact shared/root interfaces below without changing fixture or server ownership.
- The [cross-language CI/release plan](2026-09-10-cross-language-ci-release.md) runs last. It owns only root orchestration, the fourteen-profile compatibility matrix, root documentation audits, release artifact-manifest validation, workflows, and manual no-publish readiness.
- Package-manifest schema and validation are created only by the final cross-language plan at `ci/package-manifest.schema.json` and `scripts/validate-package-manifest.py`; they are release artifacts, not conformance schemas. Earlier language package tasks must remain independently executable and use self-contained tests for exact manifest shape, sorted traversal-safe artifact paths, hashes, sizes, complete output-file accounting, and symlink rejection. Root validation is applied later after those files exist.
- Registry ownership, exact final coordinates, signing, credentials, tags, release creation, and publication remain release-owner gates outside automated implementation.

## Stable Conformance Runner Contract

Every language entrypoint accepts no positional arguments and requires exactly these four variables:

```text
CEKAT_CONFORMANCE_BASE_URL
CEKAT_CONFORMANCE_CONTROL_URL
CEKAT_CONFORMANCE_ACCESS_TOKEN
CEKAT_CONFORMANCE_FIXTURES
```

Each runner discovers and validates every `*.json` file in the supplied cases directory and fails with the case ID on an unknown schema version, applicability language/capability, properties recipe, response-body recipe, cancellation phase, operation, mock-response form, expected-result form, duplicate/unaccounted case, undeclared inapplicability, or ordinary skip. The shared closed applicability table makes cancellation applicable to every language with approved native caller cancellation and explicitly `not_applicable` to synchronous-v1 PHP and Ruby. Ruby must still discover and validate all three cancellation fixtures, verify `ruby` is declared inapplicable, report `not_applicable` rather than skipped/unsupported/passed, and exit `0` when all applicable cases pass; this preserves configured Net::HTTP timeouts without inventing caller cancellation. It may not use a default URL, an environment-variable alias, an explicit fixture filename list, or a repository-relative fixture fallback. Root orchestration launches one isolated shared mock process per language, passes the readiness JSON `base_url` and `control_url` through these exact variables, requires all seven runners to exit `0`, and reports schema-declared inapplicability separately from skips.

## Required Execution Discipline

- Verify each applicable step against the authoritative design and the shared contract before implementation; preserve fixed endpoint, payload, acknowledgement, retry, error, and visitor-precedence decisions.
- Verify runtime and framework versions from official sources before dependency setup and immediately before release readiness. Record exact observed minimum/current versions and supported framework majors; never project a patch version or claim a future runtime.
- Follow strict red-green-refactor TDD with the exact paths, interfaces, commands, expected results, and commit checkpoints in each plan.
- Run independent review after the shared phase, each major language phase, and final integration.
- Do not weaken or ordinarily skip a shared case from a language plan. Only schema-declared `not_applicable` from the shared closed capability table may avoid execution; it must remain discovered, validated, and separately accounted. Contract changes begin in the approved design and shared plan, then flow to language runners and root orchestration.
- Automatic release publication is prohibited. A passing release-readiness workflow proves only local artifact and evidence readiness for manual release-owner review.
