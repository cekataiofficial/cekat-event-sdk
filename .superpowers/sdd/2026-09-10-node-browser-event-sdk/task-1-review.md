# Task 1 Review — Node/browser compatibility gate and package skeleton

## Review

### Correct
- The diff is scoped to the nine Task 1 files specified in the brief.
- `node/package.json` correctly declares ESM (`"type": "module"`), version `0.1.0`, `sideEffects: false`, the eight required explicit subpath exports, and optional peer metadata for framework/Axios integrations (`node/package.json:2-115`).
- Direct development dependencies are exact versions, and the lockfile root metadata matches them (`node/package.json:88-116`; `node/package-lock.json:8-70`). The required declaration packages and `fastify-plugin` are present in both metadata and lockfile.
- The compatibility unit test uses fixture-shaped Node/npm metadata rather than network calls and exercises EOL schedule rejection, package prerelease selection, one incompatible engine, missing Next engine, and report rendering (`node/test/compatibility/verify-compatibility.test.mjs:14-88`).
- The report records a retrieval timestamp, the two official Node URLs, the npm command form, and exact selected direct versions (`node/docs/compatibility.md:3-28`).
- No prerelease direct dependency is visible in the package manifest or the reviewed lockfile entries.

### Findings

- **P1 — The gate treats a future even-numbered line as maintained/LTS.**
  `evaluateCompatibility` accepts a schedule line whenever `schedule.lts` is truthy and its `end` is after retrieval time; it never requires the LTS date (or maintenance date) to have occurred (`node/scripts/verify-compatibility.mjs:74-79`). The test fixture itself sets Node 24’s LTS date to `2025-10-28` while evaluating at `2026-09-10`, which is fine, but the checked-in report includes Node 26 as an LTS line on `2026-09-11` (`node/docs/compatibility.md:11`) even though the gate has no mechanism to reject an announced, not-yet-LTS line.
  **Smallest fix:** require a valid LTS date `<= retrievedAt` (and likely `start <= retrievedAt`) before selecting a line; add a fixture with a future LTS date and assert it is excluded.

- **P1 — Engine compatibility validation is not semver-correct and does not cover all installed framework/type metadata.**
  `permitsNodeFloor` reduces the floor to a major integer, so it accepts `>=22.12.0` for floor `22`, even though Node `22.0.0` is excluded (`node/scripts/verify-compatibility.mjs:49-67`). This conflicts with the package’s advertised engine floor `>=22.0.0` (`node/package.json:7-9`). In addition, the `typeMatch` set is unused (`node/scripts/verify-compatibility.mjs:21`), so `@types/express` and `@types/koa` are never checked to match selected Express/Koa majors; only `@types/node` is constrained (`:90-92`). The gate queries only `@nestjs/common` but uses its selected version to install `@nestjs/core`, `@nestjs/platform-express`, and `@nestjs/platform-fastify`, without checking their own availability or Node engines (`:14-19`, `:136-140`).
  **Smallest fix:** use a real semver range evaluator against the exact package engine floor (for example `22.0.0`), query and validate each installed Nest package, and define/enforce the required runtime-to-declaration major relationships. Add negative tests for `>=22.12.0`, mismatched Express/Koa types, and a Nest companion package whose metadata disagrees.

- **P1 — “Next.js Node runtime” is asserted but not constrained by the gate.**
  The only Next-specific condition is that the selected package’s `engines.node` accepts the Node floor (`node/scripts/verify-compatibility.mjs:93-94`). That metadata says nothing about whether a future `./nextjs` adapter is imported only from a Node runtime rather than Next Edge/browser graphs. The report’s claim “Next.js is restricted to its Node runtime” is therefore unsupported by the evidence collected (`node/docs/compatibility.md:11`). The test labels a missing `engines.node` entry as an “unresolved Next Node runtime,” but it tests only that proxy condition (`node/test/compatibility/verify-compatibility.test.mjs:82-85`).
  **Smallest fix:** make the report say only what npm metadata proves (Node-version compatibility), and add a separate package-graph/runtime guard when the Next adapter exists—e.g., a fixture/import test that rejects `node:` imports from browser/Edge reachable paths and verifies Node-runtime-only adapter documentation/configuration.

- **P1 — TypeScript does not provide the required separate Node and browser compilation graphs.**
  There is one base config containing Node, Express, Koa, and DOM types and including every Node, integration, and browser source path (`node/tsconfig.json:2-14`). `tsconfig.build.json` simply inherits that mixed graph (`node/tsconfig.build.json:1-13`). Consequently, browser files are compiled with `@types/node` available and no configuration can prevent future `node:` imports from entering browser code. This directly misses the Task 1 requirement that browser sources include DOM libraries while excluding Node types and all `node:` imports.
  **Smallest fix:** split Node/framework and browser configs; make the browser config use `types: []` (or browser-only types), DOM/DOM.Iterable libs, browser-only includes, and a checked import-boundary guard. Make `typecheck` run both configs and `build` emit declarations/ESM for both.

- **P1 — The test suite does not verify the actual official-metadata gate or its required failure modes.**
  The test invokes only the exported pure evaluator/render function (`node/test/compatibility/verify-compatibility.test.mjs:3,67-88`). It does not cover `fetchJson`, npm-command failure, malformed/unavailable Node source data, CLI exit status, `--write`, or the command’s actual retrieval metadata (`node/scripts/verify-compatibility.mjs:128-154`). Thus a failure in source collection, npm invocation, CLI argument handling, or evidence writing can pass all Task 1 tests.
  **Smallest fix:** inject fetch/npm-view dependencies into the collection/CLI seam and test successful CLI write plus unavailable HTTP/npm source nonzero exits. Add the missing future-LTS, exact-engine-floor, declaration-match, and Next-target cases above.

- **P1 — Reproducible security evidence is absent; the reported npm audit issues cannot be assessed factually.**
  The requested worker artifact report is not present in the supplied Task 1 artifact directory: it contains only `progress.md`, the diff, and the brief. No reviewed file includes `npm audit` output. The diff adds a 5,623-line dependency lockfile, including production-capable framework packages, so it is not valid to infer either “no vulnerabilities” or “dev-only/non-exploitable” from this review.
  **Smallest fix:** attach the exact `npm audit --json` output generated after `npm ci`, record audit tool/version/date and the lockfile context, and triage each finding by direct/transitive dependency and production/install reachability. Remediate or explicitly document accepted residual risk; do not suppress or ignore findings.

### Quality / specification verdict
- **Specification:** **Not met.** The core gate does not reliably select active maintained LTS lines, verify exact engine-floor compatibility, verify the full installed metadata set, establish Next Node-runtime boundaries, or enforce separate browser/Node TypeScript graphs.
- **Quality:** **Not ready.** Exact direct dependency and export/peer metadata are coherent, but the gate’s test coverage is limited to its pure selection function and there is no auditable security-result artifact.
- **Merge verdict:** **BLOCK** until all P1 findings are resolved and the required validation/audit evidence is supplied.

---

## Repair evidence — 2026-09-11

All listed Task 1 P1 findings were repaired without beginning Task 2.

### Gate and metadata changes

- `node/scripts/verify-compatibility.mjs` now selects a Node line only when its `start` and `lts` dates have occurred and its `end` is in the future. The regenerated evidence selects active LTS lines 22 and 24, excluding announced-but-not-LTS Node 26.
- Engine evaluation uses the exact declared `package.json` floor (`22.0.0`), including comparator, caret, tilde, wildcard, hyphen, and OR range handling. A declared `>=22.12.0` now rejects the `22.0.0` floor; an absent engine is recorded as unconstrained rather than falsely converted to an exclusion. Next requires a declared engine to make the limited Node-engine claim.
- Collection fetches versions/time/dist-tags plus per-selected-version `engines` metadata for every installed runtime companion. It validates `@nestjs/common`, core, platform-express, and platform-fastify individually; requires their selected majors to agree; validates Express/@types-express and Koa/@types-koa major relationships; and retains @types/node selection at the Node floor major.
- The report now says exactly what npm metadata proves: Next accepts the selected Node version. It explicitly says this does **not** establish a Next runtime boundary.
- `node/scripts/check-browser-boundary.mjs` establishes the future package-graph guard: browser/Edge-reachable `src/browser` sources fail if they import `node:`. This is wired into `typecheck`; the report does not pretend that an absent adapter has been tested.

### Compilation boundaries and executable testing

- Node/framework and browser graphs are separate: `tsconfig.json` has Node/framework ambient declarations and no DOM library; `tsconfig.browser.json` has `types: []` and `ES2022`, `DOM`, and `DOM.Iterable` only. `tsconfig.build.json` and `tsconfig.browser.build.json` emit each graph separately. Placeholder declaration compilation roots permit the Task 1 skeleton to be checked before later tasks add sources.
- `typecheck` runs both graphs and the browser import boundary; `build` emits both graphs.
- Expanded strict-TDD tests in `node/test/compatibility/verify-compatibility.test.mjs` cover future LTS exclusion, exact floor incompatibility, declaration mismatch, Nest companion mismatch, honest Next report language, injected official collection, injected `--write` success, and injected Node/npm source failures.

### Commands and results

Executed from `node/` after `rm -rf node_modules dist`:

```text
npm ci                                      PASS (279 packages installed)
npm run verify:compatibility -- --write     PASS (Node >=22.0.0 <26.0.0; all 16 package selections printed)
npm run typecheck                           PASS (both TS graphs and browser boundary guard)
npm run build                               PASS (both declaration/ESM graph builds)
node --test test/compatibility/verify-compatibility.test.mjs
                                            PASS (3/3 tests)
npm audit --json > docs/evidence/npm-audit-2026-09-11.json
                                            EXPECTED EXIT 1: 4 high findings, per explicit non-blocking ruling
```

Security evidence is retained at `node/docs/evidence/npm-audit-2026-09-11.json`; reproducibility context and per-finding direct/transitive/reachability triage are at `node/docs/evidence/npm-audit-2026-09-11.md`. It records npm `11.16.0`, Node `v24.18.0`, retrieval time, the `npm ci`/audit commands, lockfile v3, and lockfile SHA-256 `2f1cb5330be9e6f6df4e25994e082de3ff44ef789c8b3d90498330a2278d3cd3`. The four high findings (`@nestjs/core`, both Nest platform companions, and transitive `multer`) are explicitly accepted only as user-ruled non-blocking residual risk and are not claimed absent or remediated.
