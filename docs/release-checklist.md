# Release checklist

The only publishing automation is `.github/workflows/release-node.yml`, which releases the npm package when a release owner pushes a `node/vX.Y.Z` tag (see [npm release](#4-npm-release)). Neither `.github/workflows/ci.yml` nor `.github/workflows/release-readiness.yml` publishes, signs, tags, or creates a release, and every `scripts/package` never publishes. Publication of the other SDKs and any signing are manual steps for the release owner, using artifacts that release readiness has built and verified.

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

- [ ] **Registry ownership and coordinates.** Confirm Cekat controls each package name: npm `@cekatai/event-sdk`, PyPI `cekat-event-sdk`, Packagist `cekat/event-sdk`, RubyGems `cekat-event-sdk`, NuGet `Cekat.EventSdk`, `Cekat.EventSdk.AspNetCore`, and `Cekat.EventSdk.AzureFunctions`, Maven Central group `ai.cekat` (namespace verification is still open; see [`java/compatibility.md`](../java/compatibility.md)), and the Go vanity path `golang.cekat.ai/event-sdk`: `https://golang.cekat.ai/event-sdk?go-get=1` and each adapter path must serve the per-module `go-import` meta tags described in [`go/COMPATIBILITY.md`](../go/COMPATIBILITY.md#module-path-update-2026-09-15-utc).
- [ ] **License and legal review** of the MIT license and third-party dependencies.
- [ ] **Changelog and release notes** approved for every SDK.
- [ ] **Signing**, where a registry requires or you choose it (for example Maven Central artifact signatures), performed by the release owner.
- [ ] **Credentials or trusted publishing** configured by the release owner; no workflow in this repository holds registry credentials (the npm release uses trusted publishing, described below).
- [ ] **Tags.** Go modules are tagged with their full directory path (`go/v0.1.0`, `go/middleware/gin/v0.1.0`), and each adapter must require a published core version. The npm package is tagged `node/v0.1.0`.
- [ ] **Publication** of exactly the verified artifacts: compare each file's SHA-256 with the release readiness summary before uploading.
- [ ] **Post-release check.** Install each published package into a clean project and send a test event to a non-production tenant.

## 4. npm release

`@cekatai/event-sdk` is released by `.github/workflows/release-node.yml` through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored in GitHub.

One-time setup:

1. On npmjs.com, create the `cekatai` organization (or confirm Cekat owns it) and add the release owners as members.
2. In the GitHub repository settings, create an environment named `npm`: add required reviewers, and restrict its deployment tags to `node/v*`. Add a tag ruleset that allows only release owners to create `node/v*` tags.
3. On npmjs.com, open the package settings for `@cekatai/event-sdk` and add a trusted publisher: provider GitHub Actions, organization `cekataiofficial`, repository `cekat-event-sdk`, workflow filename `release-node.yml`, environment `npm`. npm only offers these settings once the package exists, so first publish a placeholder version (for example `0.0.0-bootstrap.0` under the `bootstrap` dist-tag) once from a release owner's machine with two-factor authentication, then add the trusted publisher and deprecate the placeholder.
4. After the trusted publisher works, set the package's publishing access to require two-factor authentication and disallow tokens, so only the workflow can publish.

Each release:

1. Update `version` in `node/package.json` and the package version checked by `node/scripts/package` and `scripts/package-readiness.sh`, merge, and wait for `CI required`.
2. Push the tag `node/v<version>` on the release commit.
3. The `build` job runs `scripts/package-readiness.sh --language node` on a GitHub-hosted runner and uploads the verified tarball and manifest.
4. The `publish` job waits for approval in the `npm` environment, then runs on a separate GitHub-hosted runner, as npm trusted publishing requires. It checks the manifest hashes, the package name and version inside the tarball, and that the version is not already on npm, then publishes that tarball. npm adds a provenance attestation only when the GitHub repository is public. A version containing `-` gets the `next` dist-tag; any other version gets `latest`.
5. Confirm the version page on npmjs.com shows the new version (and the provenance badge once the repository is public), then run the post-release check above.
