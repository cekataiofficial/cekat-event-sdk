# Release checklist

Nothing in this repository publishes packages. Neither `.github/workflows/ci.yml` nor `.github/workflows/release-readiness.yml` publishes, signs, tags, or creates a release, and every `scripts/package` never publishes. Publication and any signing are manual steps for the release owner, using artifacts that release readiness has built and verified.

Related pages: [compatibility](compatibility.md), [SDK contract](sdk-contract.md).

## 1. Recheck versions

1. Recheck each language's runtime and framework support against the official sources listed in its evidence document (see [compatibility](compatibility.md)).
2. When support changed, update the package metadata, `ci.yml`, the evidence document, and `ci/compatibility-matrix.json` together, then set `verified_on` to today.
3. Confirm the matrix passes the release gates:

   ```sh
   python3 scripts/validate-compatibility-matrix.py --as-of "$(date -u +%F)" --max-age-days 30
   python3 scripts/audit-docs.py --write-compatibility && python3 scripts/audit-docs.py
   ```

   The release readiness preflight runs the same gate and fails if a supported line has reached end of support or the matrix was verified more than 30 days earlier.

## 2. Build and verify artifacts

1. Merge the release changes so `CI required` is green on the release commit.
2. Run the **Release readiness** workflow (`release-readiness.yml`) on that commit. It runs every language's `scripts/package` on the current toolchain, validates each `manifest.json` and the complete seven-language set with `scripts/validate-package-manifest.py`, and keeps the artifacts for 14 days.
3. Review the run summary: the artifact names, sizes, and SHA-256 hashes, and the compatibility table.
4. Download the `cekat-event-sdk-0.1.0-<language>` artifacts you will publish and keep the hashes with the release record.

## 3. Manual release gates

Complete these outside the workflows; they are not automated:

- [ ] **Registry ownership and coordinates.** Confirm Cekat controls each package name: npm `@cekat/event-sdk`, PyPI `cekat-event-sdk`, Packagist `cekat/event-sdk`, RubyGems `cekat-event-sdk`, NuGet `Cekat.EventSdk`, `Cekat.EventSdk.AspNetCore`, and `Cekat.EventSdk.AzureFunctions`, Maven Central group `ai.cekat` (namespace verification is still open; see [`java/compatibility.md`](../java/compatibility.md)), and the Go module path `github.com/cekataiofficial/cekat-event-sdk-go` with its adapter modules.
- [ ] **License and legal review** of the MIT license and third-party dependencies.
- [ ] **Changelog and release notes** approved for every SDK.
- [ ] **Signing**, where a registry requires or you choose it (for example Maven Central artifact signatures), performed by the release owner.
- [ ] **Credentials or trusted publishing** configured by the release owner; no workflow in this repository holds registry credentials.
- [ ] **Tags.** Go adapter modules are tagged with their directory prefix (for example `middleware/gin/v0.1.0`), and each adapter must require a published core version.
- [ ] **Publication** of exactly the verified artifacts: compare each file's SHA-256 with the release readiness summary before uploading.
- [ ] **Post-release check.** Install each published package into a clean project and send a test event to a non-production tenant.
