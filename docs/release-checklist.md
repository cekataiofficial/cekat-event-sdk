# Release checklist

Every language releases from a workflow, each started by a release owner pushing that language's tag: [npm](#4-npm-release) (`node/vX.Y.Z`), [Go](#5-go-release) (`go/vX.Y.Z`), [PyPI](#6-pypi-release) (`python/vX.Y.Z`), [RubyGems](#7-rubygems-release) (`ruby/vX.Y.Z`), [Maven Central](#8-maven-central-release) (`java/vX.Y.Z`), [Packagist](#9-packagist-release) (`php/vX.Y.Z`), and [NuGet](#10-nuget-release) (`dotnet/vX.Y.Z`). Each one rebuilds and verifies the package with `scripts/package-readiness.sh` before anything leaves the repository, and each waits for approval in its own GitHub environment. Neither `.github/workflows/ci.yml` nor `.github/workflows/release-readiness.yml` publishes, signs, tags, or creates a release, and every `scripts/package` never publishes. Publication of the other SDKs and any signing are manual steps for the release owner, using artifacts that release readiness has built and verified.

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
- [ ] **Signing**, where a registry requires or you choose it. Maven Central requires a `.asc` signature beside every file; `release-java.yml` signs with the key in the `maven-central` environment.
- [ ] **Credentials or trusted publishing** configured by the release owner. npm, PyPI, RubyGems, and NuGet use trusted publishing and store nothing. Maven Central and Packagist have no trusted publishing, so `release-java.yml` and `release-php.yml` read secrets from their own approval-gated environments; no other workflow may hold credentials.
- [ ] **Tags.** Go modules are tagged with their full directory path (`go/v0.1.0`, `go/middleware/gin/v0.1.0`); pushing the core tag creates the adapter tags. The npm package is tagged `node/v0.1.0`.
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

## 5. Go release

Go has no registry upload: the tags in this repository are the release, and `go get` reads them through `proxy.golang.org`. `.github/workflows/release-go.yml` turns one core tag into the complete set.

One-time setup:

1. The GitHub repository must be public, and `golang.cekat.ai` must serve the per-module `go-import` meta tags described in [`go/COMPATIBILITY.md`](../go/COMPATIBILITY.md#module-path-update-2026-09-15-utc). Until both are true, the modules resolve for nobody and the workflow's proxy step reports the paths it could not resolve.
2. Create a GitHub environment named `go-release` with the release owners as required reviewers, and restrict its deployment tags to `go/v*`.
3. Restrict only `go/v*` in the tag ruleset, not `go/middleware/**`. A ruleset bypass list accepts repository roles, teams, GitHub Apps, and Dependabot, but not the Actions token, so restricting the adapter tags would stop the workflow from creating them. Gating the core tag is enough, because nothing else creates adapter tags. To lock them as well, install a GitHub App with `contents: write`, add it to the bypass list, and mint its token in the workflow instead of using `GITHUB_TOKEN`.

Each release:

1. Set every adapter's core requirement to the version being released: `require golang.cekat.ai/event-sdk vX.Y.Z` in `go/middleware/<name>/go.mod`. The workflow refuses the release otherwise, because a published tag cannot be corrected.
2. Merge, wait for `CI required`, then push the core tag on the release commit:

   ```sh
   git fetch origin && git tag go/v0.1.0 origin/main && git push origin go/v0.1.0
   ```

3. The `verify` job checks the tag shape and the adapter requirements, then runs `scripts/package-readiness.sh --language go`, which tests and vets every module and builds the five archives with their SHA-256 manifest.
4. Approve the `release` job in the `go-release` environment. It confirms the tagged commit is on `main` and the archives carry the released version, creates `go/middleware/{chi,echo,fiber,gin}/vX.Y.Z` at the same commit, publishes a GitHub Release per module with its archive attached, and asks `proxy.golang.org` for each module path so pkg.go.dev indexes it. Rerunning the job is safe: existing tags and releases are left alone.
5. Confirm from a clean directory that the modules resolve:

   ```sh
   go list -m golang.cekat.ai/event-sdk@v0.1.0 golang.cekat.ai/event-sdk/middleware/gin@v0.1.0
   ```

## 6. PyPI release

`cekat-event-sdk` is released by `.github/workflows/release-python.yml` through [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/), so no API token is stored.

One-time setup:

1. Each release owner needs a PyPI account with two-factor authentication enabled.
2. In the GitHub repository settings, create an environment named `pypi` with required reviewers, and restrict its deployment tags to `python/v*`.
3. On PyPI, open your account sidebar, click **Publishing**, and add a **pending publisher** for GitHub Actions: PyPI project name `cekat-event-sdk`, owner `cekataiofficial`, repository `cekat-event-sdk`, workflow filename `release-python.yml`, environment `pypi`. A pending publisher works before the project exists and becomes a normal publisher on the first upload, so no placeholder release is needed. It does not reserve the name, so publish soon after registering it.
4. Add `python/v*` to the tag ruleset so only release owners can start a release.

Each release:

1. Update `version` in `python/pyproject.toml` and the version constant in `python/scripts/package`, merge, and wait for `CI required`.
2. Push the tag `python/v<version>` on the release commit.
3. The `build` job checks the tag against `pyproject.toml` and runs `scripts/package-readiness.sh --language python`, which produces the wheel and sdist with a SHA-256 manifest.
4. Approve the `publish` job in the `pypi` environment. It revalidates the manifest, copies only the two distributions out of the artifact directory, refuses a version that already exists, and uploads them with attestations.
5. Check the project page, then install the release into a clean virtual environment as the post-release check.

## 7. RubyGems release

The `cekat-event-sdk` gem is released by `.github/workflows/release-ruby.yml` through [RubyGems trusted publishing](https://guides.rubygems.org/trusted-publishing/), so no API key is stored.

One-time setup:

1. Each release owner needs a RubyGems account with multi-factor authentication enabled.
2. In the GitHub repository settings, create an environment named `rubygems` with required reviewers, and restrict its deployment tags to `ruby/v*`.
3. On RubyGems.org, open your profile, go to the pending trusted publisher page, and create one: gem name `cekat-event-sdk`, owner `cekataiofficial`, repository `cekat-event-sdk`, workflow filename `release-ruby.yml`, environment `rubygems`. Like PyPI, this works before the gem exists, so no placeholder push is needed. Once the gem exists, the same settings live under **Trusted publishers** in the gem's sidebar.
4. Add `ruby/v*` to the tag ruleset so only release owners can start a release.

Each release:

1. Update `CekatEventSdk::VERSION` in `ruby/lib/cekat_event_sdk/version.rb` and the version constant in `ruby/scripts/package`, merge, and wait for `CI required`.
2. Push the tag `ruby/v<version>` on the release commit.
3. The `build` job checks the tag against the version constant and runs `scripts/package-readiness.sh --language ruby`, which runs the specs, RuboCop, and the bundle audit, then builds the gem with a SHA-256 manifest.
4. Approve the `publish` job in the `rubygems` environment. It revalidates the manifest, checks the name and version inside the gem, refuses a version that already exists, exchanges the job's OIDC token for short-lived credentials, and pushes that gem file.
5. Check the gem page, then install the release into a clean bundle as the post-release check.

## 8. Maven Central release

Maven Central has no trusted publishing, and a published version can never be replaced or removed. `.github/workflows/release-java.yml` therefore holds credentials and stops short of publishing: it uploads a validated deployment and a release owner presses the final button.

One-time setup:

1. Create a Sonatype account at [central.sonatype.com](https://central.sonatype.com/), then register the `ai.cekat` namespace. The Portal verifies it through DNS: the namespace is the company domain reversed, so add the TXT record it shows to that domain's zone, the same zone that serves the Go vanity host.
2. On the Portal account page, generate a user token. It is a username and password pair.
3. Create an OpenPGP signing key for releases (`gpg --full-generate-key`, RSA 4096, no expiry or a long one), publish the public key to `keys.openpgp.org` so Central can verify signatures, and export the private key with `gpg --armor --export-secret-keys <key-id>`. Keep the private key and its passphrase in your password manager as well.
4. In the GitHub repository settings, create an environment named `maven-central` with required reviewers, restrict its deployment tags to `java/v*`, and add four **environment** secrets: `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `GPG_PRIVATE_KEY` (the armored private key), and `GPG_PASSPHRASE`. Environment secrets are unreadable outside the approved job.
5. Add `java/v*` to the tag ruleset.

Each release:

1. Update the version in `java/pom.xml` (and the modules that name it) and in `java/scripts/package`, merge, and wait for `CI required`.
2. Push the tag `java/v<version>` on the release commit.
3. The `build` job checks the tag against the POM version and runs `scripts/package-readiness.sh --language java`, producing the jar, sources jar, javadoc jar, and POM for each artifact in the `ai/cekat/...` layout with a SHA-256 manifest.
4. Approve the `publish` job in the `maven-central` environment. It revalidates the manifest, signs every file and writes its `.md5` and `.sha1`, zips the bundle, uploads it to the Portal, and polls until the deployment is `VALIDATED`. Nothing is public at this point.
5. Open [the Portal's deployments page](https://central.sonatype.com/publishing/deployments), review the deployment named in the job summary, and press **Publish**. Artifacts appear on Maven Central within about 15 minutes and in search later.
6. Post-release check: resolve `ai.cekat:cekat-event-sdk-core:<version>` in a clean local repository.

Switch the workflow's `publishingType` to `AUTOMATIC` only once you trust the pipeline; `USER_MANAGED` is what keeps a permanent mistake reversible.

## 9. Packagist release

Packagist stores no archives and requires `composer.json` at a repository root, so this monorepo cannot be submitted directly. `.github/workflows/release-php.yml` mirrors the `php/` directory to `cekataiofficial/cekat-event-sdk-php` — where `composer.json` sits at the root — and tags it there. The mirror is generated output: all development stays in this repository.

One-time setup:

1. Create the public repository `cekataiofficial/cekat-event-sdk-php`, empty, with a `main` branch. Its description should say it is generated from this repository.
2. Generate a dedicated SSH key pair (`ssh-keygen -t ed25519 -C "cekat-event-sdk-php mirror" -f mirror-key -N ""`) and add the public half to the mirror under **Settings → Deploy keys** with **Allow write access**. A deploy key belongs to the mirror repository, so releases do not depend on any person's account, it never expires, and it cannot reach another repository.
3. In this repository's settings, create an environment named `packagist` with required reviewers, restrict its deployment tags to `php/v*`, and add the private half as the environment secret `PHP_MIRROR_DEPLOY_KEY`. Delete the local copy of the private key afterwards, keeping a backup only in your password manager.
4. The mirror must be **public**: Packagist indexes only public repositories. Once it has content, submit `https://github.com/cekataiofficial/cekat-event-sdk-php` on Packagist, which claims the `cekat` vendor name. Then enable automatic updates with a push webhook on the mirror (payload URL `https://packagist.org/api/github?username=<packagist-user>`, content type `application/json`, secret = your Packagist API token, push events only). The webhook keeps the integration scoped to the mirror; Packagist's OAuth integration is the alternative, but it authorizes the whole GitHub organization and cannot be limited to one repository. Submitting before the first release tag means the workflow's Packagist check passes on the first run; until the package is registered, that step only warns.
5. Add `php/v*` to the tag ruleset.

Each release:

1. Update the version constant in `php/scripts/package`, merge, and wait for `CI required`. `php/composer.json` declares no version, because Packagist derives versions from tags.
2. Push the tag `php/v<version>` on the release commit.
3. The `build` job checks the tag against that constant and runs `scripts/package-readiness.sh --language php`, which runs the tests, PHPStan, the coding-standard check, and `composer archive`.
4. Approve the `publish` job in the `packagist` environment. It confirms the tagged commit is on `main`, refuses a tag the mirror already has, replaces the mirror's contents with this tag's `php/` directory, commits, pushes, tags `v<version>`, and then waits for Packagist to list the version. If Packagist has not picked it up, the job warns instead of failing; check the GitHub App hook on the mirror.
5. Post-release check: `composer require cekat/event-sdk` in a clean project.

## 10. NuGet release

The three `Cekat.EventSdk` packages are released by `.github/workflows/release-dotnet.yml` through [NuGet trusted publishing](https://learn.microsoft.com/en-us/nuget/nuget-org/trusted-publishing), so no API key is stored. nuget.org issues a key that is valid for one hour, and the workflow requests it immediately before pushing.

One-time setup:

1. Each release owner needs a nuget.org account with two-factor authentication. Note the **profile name**, not the email address: that is what the login step sends.
2. In the GitHub repository settings, create an environment named `nuget` with required reviewers, and restrict its deployment tags to `dotnet/v*`.
3. Add a repository **variable** (not a secret) named `NUGET_USER` with that profile name, under Settings, Secrets and variables, Actions, Variables.
4. On nuget.org, open your username menu, choose **Trusted Publishing**, and add a policy: owner (you or the Cekat organization), Repository Owner `cekataiofficial`, Repository `cekat-event-sdk`, Workflow File `release-dotnet.yml` (file name only), Environment `nuget`. Set the policy scopes to allow publishing new packages and new versions, with a glob such as `Cekat.EventSdk*`. A new policy may start **temporarily active for 7 days** until a first successful publish records the repository and owner IDs, so publish within that window or restart it.
5. Add `dotnet/v*` to the tag ruleset.

Each release:

1. Update `<Version>` in `dotnet/Directory.Build.props` and the version constant in `dotnet/scripts/package`, merge, and wait for `CI required`.
2. Push the tag `dotnet/v<version>` on the release commit.
3. The `build` job checks the tag against `Directory.Build.props` and runs `scripts/package-readiness.sh --language dotnet`, which tests on the current framework, fails on vulnerable dependencies, and packs the three `.nupkg` files with a SHA-256 manifest.
4. Approve the `publish` job in the `nuget` environment. It revalidates the manifest, refuses any package version that already exists, exchanges the OIDC token for a one-hour key, and pushes the three packages.
5. nuget.org validates and indexes each package, usually within a few minutes. Post-release check: `dotnet add package Cekat.EventSdk --version <version>` in a clean project.

