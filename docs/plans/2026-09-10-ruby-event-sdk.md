# Ruby Core, Rack, and Rails CurrentAttributes Implementation Plan

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).


> **Implementation notes (2026-09-13) — as built, overriding the tasks below.** Ruby floor 3.3 (3.2 is end of life); Rails 8.0–8.1 (7.2 is end of life); Rack 2.2–3.2 with no runtime Rack dependency. Framework lines are selected with `RAILS_VERSION`/`RACK_VERSION`/`JSON_VERSION` in the Gemfile instead of Appraisal, and `Gemfile.lock` is not committed. `EventInput` adds `event_id`/`occurred_at`; event methods also accept keyword attributes or a Hash; `order_paid(event = nil, amount:, currency:, **attributes)`. `Error#delivery_outcome_unknown?` is a predicate. Properties accept Symbol keys/values and BigDecimal/Rational (sent as floats). The Rails middleware sets both `CekatEventSdk::Rails::Current.visitor_id` and the fiber scope so the default client works without injection. Tests use real TCP servers instead of WebMock. Net::HTTP `ignore_eof` is disabled so truncated bodies are body read failures. Evidence and the tested matrix are in `ruby/COMPATIBILITY.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
**Goal:** Build a Ruby `cekat-event-sdk` gem with a Net::HTTP core, Rack middleware, a Rails `ActiveSupport::CurrentAttributes` adapter, and exhaustive shared-fixture conformance.
**Architecture:** Core code validates events, serializes JSON, performs bounded synchronous retries, and supports an explicit fiber-local visitor scope only on evidence-selected Ruby lines that provide `Fiber.[]` and `Fiber.[]=`. Rack’s environment is canonical for each Rack request and middleware bridges its value into the generic scope for code executed in that fiber. Rails uses `CurrentAttributes` as adapter-owned state: nested scopes rely on `Current.set` replacement/restoration, while top-level framework teardown performs `Current.reset`. These mechanisms isolate supported request/fiber execution paths; the plan does not claim that arbitrary user-created threads inherit ambient visitor state.
**Tech Stack:** evidence-selected maintained Ruby versions, Net::HTTP, JSON, Rack, ActiveSupport/Railties, RSpec, and WebMock, with exact versions recorded before dependency setup.
**Spec:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md`
## Global constraints
- Select the minimum and current stable Ruby lines from current official lifecycle evidence; do not pre-claim Ruby, Rack, or Rails versions. Every selected Ruby line must provide the verified `Fiber.[]`/`Fiber.[]=` API.
- Do not use `Thread.current` as a fiber-safe request store.
- Net::HTTP first release supports configured request timeouts, not a custom caller-cancellation token.
- Retry backoff remains injectable for deterministic tests.
- Rack `env` and Rails `CurrentAttributes` are canonical for their integrations.
- Access tokens must never enter Rack env, Rails Current state, errors, diagnostics, or logs.
- Keep core runtime dependencies to Ruby standard-library Net::HTTP/URI/JSON.
- Package version is `0.1.0`.
## Exact file map
```text
ruby/
├── cekat-event-sdk.gemspec
├── Gemfile
├── Gemfile.lock
├── Appraisals
├── Rakefile
├── COMPATIBILITY.md
├── README.md
├── lib/
│   ├── cekat-event-sdk.rb
│   └── cekat_event_sdk/
│       ├── acknowledgement.rb
│       ├── client.rb
│       ├── configuration.rb
│       ├── constants.rb
│       ├── errors.rb
│       ├── event_input.rb
│       ├── response_decoder.rb
│       ├── retry_policy.rb
│       ├── transport.rb
│       ├── validation.rb
│       ├── version.rb
│       ├── visitor_context.rb
│       ├── visitor_id_resolver.rb
│       ├── rack/
│       │   └── middleware.rb
│       └── rails/
│           ├── current.rb
│           ├── middleware.rb
│           ├── railtie.rb
│           └── visitor_context.rb
├── scripts/
│   ├── conformance
│   └── package
└── spec/
    ├── acknowledgement_spec.rb
    ├── client_payload_spec.rb
    ├── client_response_spec.rb
    ├── client_retry_spec.rb
    ├── client_security_spec.rb
    ├── event_input_spec.rb
    ├── readme_contract_spec.rb
    ├── spec_helper.rb
    ├── conformance/
    │   ├── conformance_spec.rb
    │   ├── fixture_loader.rb
    │   ├── mock_control_client.rb
    │   ├── recipe_factory.rb
    │   └── result_assertions.rb
    ├── support/
    │   ├── fake_sleeper.rb
    │   └── mock_transport.rb
    ├── visitor_context_spec.rb
    ├── rack/
    │   └── middleware_spec.rb
    └── rails/
        └── middleware_spec.rb
```
### Task 1: Verify compatibility, bootstrap the gem, and define immutable public values
**Files:**
- Create: `ruby/COMPATIBILITY.md`
- Create: gem metadata/build files
- Create: `version.rb`, `constants.rb`, `configuration.rb`, `event_input.rb`, `acknowledgement.rb`
- Create: `spec/spec_helper.rb`, `spec/event_input_spec.rb`, `spec/acknowledgement_spec.rb`
**Interfaces:**
- Consumes: no earlier task.
- Produces:
  ```ruby
  module CekatEventSdk
    VERSION = "0.1.0"
    DEFAULT_BASE_URL = "https://t.cekat.ai"
    INGEST_PATH = "/api/events/ingest"
    VISITOR_HEADER = "X-Cekat-Visitor-ID"
    VISITOR_COOKIE = "_cekat_visitor_id"
    MAXIMUM_RESPONSE_BODY_BYTES = 65_536
    EventInput = Data.define(
      :email, :phone_number, :contact_name, :properties, :visitor_id
    ) do
      def initialize(email: nil, phone_number: nil, contact_name: nil,
                     properties: nil, visitor_id: nil)
        super
      end
    end
    Acknowledgement = Data.define(
      :success, :message, :event_key, :validated_properties, :raw_body
    )
  end
  ```
  `Configuration` exposes `access_token`, `base_url`, `timeout`, and `retry_count`, with 10 seconds and 2 retries as defaults.
- [ ] **Step 1: Record official compatibility evidence before selecting dependencies**
  Run:
  ```bash
  mkdir -p ruby
  curl -fsSL https://www.ruby-lang.org/en/downloads/branches/
  curl -fsSL https://rubygems.org/api/v1/gems/rack.json
  curl -fsSL https://rubygems.org/api/v1/gems/rails.json
  curl -fsSL https://rubygems.org/api/v1/gems/bundler.json
  curl -fsSL https://rubygems.org/api/v1/gems/rspec.json
  curl -fsSL https://rubygems.org/api/v1/gems/webmock.json
  ruby --version
  gem --version
  ```
  Expected: all commands exit `0`. Record UTC date, source URLs, complete outputs/metadata, maintained minimum and current stable Ruby lines, exact Bundler/RSpec/WebMock versions, maintained Rack/Rails majors, and compatible Ruby/framework pairings in `ruby/COMPATIBILITY.md`. Verify `Fiber.respond_to?(:[])` and `Fiber.respond_to?(:[]=)` under every selected Ruby interpreter. Derive `required_ruby_version`, gem constraints, Appraisal names, and CI rows only from this evidence. Stop rather than guessing if lifecycle or framework metadata is ambiguous; do not label Rails 7/8 or Ruby 3.2 supported merely because a local install succeeds.
- [ ] **Step 2: Add gem skeleton and install the pinned toolchain**
  Pin the observed Bundler version, create `Gemfile`/gemspec/Appraisals from `COMPATIBILITY.md`, then run:
  ```bash
  cd ruby
  gem install bundler --version "$(awk '/^Bundler version:/ {print $3}' COMPATIBILITY.md)" --no-document
  bundle install
  ```
  Expected: `Gemfile.lock` records exact development versions and installation succeeds on the selected minimum Ruby line.
- [ ] **Step 3: Add failing value tests**
  Test version `0.1.0`, approved constants/defaults, keyword construction, frozen property structures after defensive deep-copy, and preservation of identity whitespace.
- [ ] **Step 4: Verify red**
  Run: `cd ruby && bundle exec rspec spec/event_input_spec.rb spec/acknowledgement_spec.rb`
  Expected: load failure for `cekat-event-sdk`, not a missing dependency error.
- [ ] **Step 5: Implement the public values**
  Defensively copy/freeze property hashes and nested arrays/hashes so caller mutation cannot alter a queued request. Preserve string content exactly.
- [ ] **Step 6: Verify green**
  Run: `cd ruby && bundle exec rspec spec/event_input_spec.rb spec/acknowledgement_spec.rb`
  Expected: all value tests pass.
- [ ] **Step 7: Commit**
  ```bash
  git add ruby
  git commit -m "build(ruby): bootstrap event SDK gem"
  ```
### Task 2: Implement errors, validation, and safe generic visitor scope
**Files:**
- Create: `ruby/lib/cekat_event_sdk/{errors,validation,visitor_context,visitor_id_resolver}.rb`
- Create: `ruby/spec/visitor_context_spec.rb`
- Modify: `ruby/spec/event_input_spec.rb`
**Interfaces:**
- Consumes: Task 1 values.
- Produces:
  ```ruby
  module CekatEventSdk
    class Error < StandardError
      attr_reader :attempts, :delivery_outcome_unknown
    end
    class ValidationError < Error; end
    class ApiError < Error
      attr_reader :status, :code, :raw_body
    end
    class AuthenticationError < ApiError; end
    class EventDefinitionNotFoundError < ApiError; end
    class TransportError < Error
      attr_reader :cause
    end
    class ResponseDecodeError < Error
      attr_reader :raw_body, :cause
    end
    class UnsupportedScopeError < Error; end
    module VisitorContext
      def self.current_visitor_id; end
      def self.with(visitor_id)
        # returns the block result and restores prior fiber state in ensure
      end
    end
    module VisitorIdResolver
      def self.from_header_and_cookie(header:, cookie:); end
      def self.for_event(explicit:, context: VisitorContext); end
    end
  end
  ```
- [ ] **Step 1: Write failing validation and fiber tests**
  Cover identity/key validation, string-only top-level property keys, recursive JSON compatibility, precedence, nested scope restoration, exception cleanup, and fiber isolation. Assert no fallback to `Thread.current`.
  ```ruby
  it "isolates two interleaved fibers" do
    first = Fiber.new do
      CekatEventSdk::VisitorContext.with("visitor-a") do
        Fiber.yield
        CekatEventSdk::VisitorContext.current_visitor_id
      end
    end
    second = Fiber.new do
      CekatEventSdk::VisitorContext.with("visitor-b") do
        Fiber.yield
        CekatEventSdk::VisitorContext.current_visitor_id
      end
    end
    first.resume
    second.resume
    expect(first.resume).to eq("visitor-a")
    expect(second.resume).to eq("visitor-b")
    expect(CekatEventSdk::VisitorContext.current_visitor_id).to be_nil
  end
  ```
- [ ] **Step 2: Verify red**
  Run:
  ```bash
  cd ruby
  bundle exec rspec spec/event_input_spec.rb spec/visitor_context_spec.rb
  ```
  Expected: missing validation and visitor modules.
- [ ] **Step 3: Implement fiber storage with feature detection**
  Use the class-level `Fiber[key]` and `Fiber[key]=` APIs only when `Fiber.respond_to?(:[])` and `Fiber.respond_to?(:[]=)` are both true; do not call `Fiber.current[key]`. Raise `UnsupportedScopeError` with guidance to pass `visitor_id` explicitly or use the framework-native canonical store if safe fiber storage is unavailable. Restore the exact previous value in `ensure`. Test the actual API under every Ruby line selected in `COMPATIBILITY.md`; state only fiber-local isolation, not inheritance into arbitrary new threads/fibers.
- [ ] **Step 4: Verify green**
  Run: `cd ruby && bundle exec rspec spec/event_input_spec.rb spec/visitor_context_spec.rb --seed 12345`
  Expected: all tests pass without thread-local state.
- [ ] **Step 5: Commit**
  ```bash
  git add ruby/lib/cekat_event_sdk ruby/spec
  git commit -m "feat(ruby): add validation and fiber-safe visitor scope"
  ```
### Task 3: Implement transport, retry policy, decoding, and client methods
**Files:**
- Create: `transport.rb`, `retry_policy.rb`, `response_decoder.rb`, `client.rb`
- Create: all client specs and support doubles listed in the map
**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  ```ruby
  class CekatEventSdk::Client
    def initialize(
      access_token:,
      base_url: CekatEventSdk::DEFAULT_BASE_URL,
      timeout: 10,
      retry_count: 2,
      transport: CekatEventSdk::Transport.new,
      visitor_context: CekatEventSdk::VisitorContext,
      sleeper: ->(seconds) { sleep(seconds) },
      random: Random.new
    ); end
    def user_registration(event); end
    def user_login(event); end
    def order_created(event); end
    def order_paid(event); end
    def custom_event(event_key, event); end
    def with_visitor_id(visitor_id, &block)
      CekatEventSdk::VisitorContext.with(visitor_id, &block)
    end
  end
  class CekatEventSdk::Transport
    Response = Data.define(:status, :reason, :body)
    def post(uri:, access_token:, json_body:, timeout:); end
  end
  ```
- [ ] **Step 1: Write failing payload tests**
  Assert exact common/custom keys, `is_common`, fixed path under overridden base URL, bearer auth, omission of null optionals, no `business_id`, explicit/context visitor precedence, and JSON-compatible properties.
- [ ] **Step 2: Write failing response/retry tests**
  Cover the approved nested success and error envelopes, malformed bodies, 64 KiB bound, exact attempt counts, only `500`/network/timeout retries, full-jitter bounds, and no retry for permanent statuses.
  Use this deterministic seam:
  ```ruby
  sleeper = ->(seconds) { observed_delays << seconds }
  random = instance_double(Random)
  allow(random).to receive(:rand).with(0.0..1.0).and_return(0.5, 1.0)
  ```
  Expected retry delays are 0.05 seconds and 0.2 seconds for those random values.
- [ ] **Step 3: Write failing redaction and timeout tests**
  Assert exception messages/inspection do not contain the token. Assert Net::OpenTimeout, Net::ReadTimeout, `Timeout::Error`, `EOFError`, `ECONNRESET`, and `ECONNREFUSED` are retriable and eventually become `TransportError` with `delivery_outcome_unknown == true`. Do not introduce a cancellation-token API.
- [ ] **Step 4: Verify red**
  Run:
  ```bash
  cd ruby
  bundle exec rspec \
    spec/client_payload_spec.rb \
    spec/client_response_spec.rb \
    spec/client_retry_spec.rb \
    spec/client_security_spec.rb
  ```
  Expected: client/transport constants are missing.
- [ ] **Step 5: Implement Net::HTTP transport**
  Create one `Net::HTTP` session per attempt. Set `open_timeout`, `read_timeout`, and `write_timeout` when supported to the configured 10-second default. Build a new `Net::HTTP::Post`, set only content type and bearer authorization, and never include the token in raised messages.
- [ ] **Step 6: Implement retry and decoding**
  Use `random.rand(0.0..1.0) * 0.1` before retry 1 and `* 0.2` before retry 2. Retry HTTP status exactly `500`. Decode only status `200` as success. Truncate non-200 raw bodies; reject oversized success bodies. Map statuses to typed errors and record attempts.
- [ ] **Step 7: Verify green**
  Run:
  ```bash
  cd ruby
  bundle exec rspec --format documentation
  bundle exec rake build
  ```
  Expected: all core tests pass and `pkg/cekat-event-sdk-0.1.0.gem` is built.
- [ ] **Step 8: Commit**
  ```bash
  git add ruby/lib ruby/spec ruby/Rakefile
  git commit -m "feat(ruby): submit events with bounded retries"
  ```
### Task 4: Implement Rack middleware with env-canonical cleanup
**Files:**
- Create: `ruby/lib/cekat_event_sdk/rack/middleware.rb`
- Create: `ruby/spec/rack/middleware_spec.rb`
**Interfaces:**
- Consumes: core resolver and generic visitor scope.
- Produces:
  ```ruby
  class CekatEventSdk::Rack::Middleware
    ENV_KEY = "cekat_event_sdk.visitor_id"
    def initialize(app); end
    def call(env); end
  end
  ```
- [ ] **Step 1: Write failing Rack tests**
  Use `Rack::MockRequest.env_for`. Assert header-over-cookie, trimming, no response cookie, env visibility, ordinary client scope visibility, restoration of a prior env value, cleanup after an exception, and two interleaved fibers with distinct env hashes.
- [ ] **Step 2: Verify red**
  Run: `cd ruby && bundle exec rspec spec/rack/middleware_spec.rb`
  Expected: missing Rack middleware.
- [ ] **Step 3: Implement complete middleware**
  ```ruby
  def call(env)
    had_previous = env.key?(ENV_KEY)
    previous = env[ENV_KEY]
    request = ::Rack::Request.new(env)
    visitor_id = VisitorIdResolver.from_header_and_cookie(
      header: request.get_header("HTTP_X_CEKAT_VISITOR_ID"),
      cookie: request.cookies[VISITOR_COOKIE]
    )
    visitor_id ? env[ENV_KEY] = visitor_id : env.delete(ENV_KEY)
    VisitorContext.with(visitor_id) { @app.call(env) }
  ensure
    had_previous ? env[ENV_KEY] = previous : env.delete(ENV_KEY)
  end
  ```
- [ ] **Step 4: Verify green under randomized order**
  Run: `cd ruby && bundle exec rspec spec/rack/middleware_spec.rb --order random --seed 20260910`
  Expected: all Rack cleanup and isolation tests pass.
- [ ] **Step 5: Commit**
  ```bash
  git add ruby/lib/cekat_event_sdk/rack ruby/spec/rack
  git commit -m "feat(ruby): add Rack visitor middleware"
  ```
### Task 5: Implement Rails CurrentAttributes adapter
**Files:**
- Create: all four files under `ruby/lib/cekat_event_sdk/rails/`
- Create: `ruby/spec/rails/middleware_spec.rb`
- Modify: `ruby/lib/cekat-event-sdk.rb`
**Interfaces:**
- Consumes: core resolver.
- Produces:
  ```ruby
  class CekatEventSdk::Rails::Current < ActiveSupport::CurrentAttributes
    attribute :visitor_id
  end
  class CekatEventSdk::Rails::VisitorContext
    def self.current_visitor_id
      Current.visitor_id
    end
  end
  class CekatEventSdk::Rails::Middleware
    def initialize(app); end
    def call(env); end
  end
  class CekatEventSdk::Rails::Railtie < ::Rails::Railtie
    # inserts CekatEventSdk::Rails::Middleware
  end
  ```
- [ ] **Step 1: Write failing Rails adapter tests**
  Test Current visibility, header-over-cookie, and client injection through `visitor_context: CekatEventSdk::Rails::VisitorContext`. Separately test (a) nested middleware calls restore a preexisting complete `Current` state after normal return and exception and (b) a top-level framework teardown hook resets state after normal return and exception when no parent scope exists. Assert an outer visitor remains visible after each nested call.
- [ ] **Step 2: Verify red**
  Run:
  ```bash
  cd ruby
  appraisal="$(awk '/^Rails appraisal:/ {print $3; exit}' COMPATIBILITY.md)"
  test -n "$appraisal"
  bundle exec appraisal "$appraisal" rspec spec/rails/middleware_spec.rb
  ```
  Expected: the appraisal exists, then tests fail because Rails adapter classes are missing rather than because dependencies are absent.
- [ ] **Step 3: Implement coherent CurrentAttributes lifecycles**
  The nestable middleware path is exactly `Current.set(visitor_id: visitor_id) { @app.call(env) }`; it has no unconditional reset because `set` restores the complete parent state on block exit. Register a separate top-level Rails executor/to-complete teardown hook in the Railtie that calls `Current.reset` only after the outermost framework request lifecycle, where no parent Cekat scope is being restored. Do not wrap `Current.set` in `ensure { Current.reset }`. The Railtie emits no event and inspects no authenticated user.
- [ ] **Step 4: Test only evidence-selected framework/runtime pairings**
  Run:
  ```bash
  cd ruby
  bundle exec appraisal install
  while IFS= read -r appraisal; do
    bundle exec appraisal "$appraisal" rspec spec/rails/middleware_spec.rb || exit 1
  done < <(awk '/^Rails appraisal:/ {print $3}' COMPATIBILITY.md)
  ```
  Expected: every recorded maintained pairing passes both nested restoration and top-level teardown tests. Any non-installable or failing pairing blocks the claim and requires an evidence/matrix change through review; do not lower dependency security or claim an unverified Rails major.
- [ ] **Step 5: Commit**
  ```bash
  git add ruby/lib/cekat_event_sdk/rails ruby/spec/rails ruby/Appraisals
  git commit -m "feat(ruby): add Rails CurrentAttributes integration"
  ```
### Task 6: Implement exhaustive fixture-driven Ruby conformance
**Files:**
- Create: every file under `ruby/spec/conformance/` from the exact map
- Create: `ruby/scripts/conformance`

**Interfaces:**
- Consumes only the shared plan's `conformance/fixtures/cases/*.json`, mock ingest origin, and control origin.
- Produces executable `ruby/scripts/conformance` accepting no arguments and requiring exactly `CEKAT_CONFORMANCE_BASE_URL`, `CEKAT_CONFORMANCE_CONTROL_URL`, `CEKAT_CONFORMANCE_ACCESS_TOKEN`, and `CEKAT_CONFORMANCE_FIXTURES`.

- [ ] **Step 1: Write failing loader/dispatcher and script contract specs**
  `FixtureLoader` reads every `*.json` directly beneath the supplied absolute cases directory, sorts paths, requires at least one case, rejects duplicate IDs, and recursively rejects unknown object keys. Specs generate temporary cases proving an unknown `schema_version`, applicability language/capability, operation, properties recipe, response-body recipe, cancellation phase, mock-response form, or result form fails with the case ID. They also prove that duplicate applicability values, undeclared inapplicability, and any cancellation fixture that does not explicitly list `ruby` as inapplicable are rejected. Run:
  ```bash
  cd ruby
  bundle exec rspec spec/conformance
  test -x scripts/conformance
  ```
  Expected: FAIL because helpers and script do not exist.

- [ ] **Step 2: Implement complete fixture/recipe handling**
  Parse all shared `Case`, closed `applicability`, `MockResponse`, expected request, acknowledgement, and result fields without a case-ID or filename allowlist. Fix this runner's language identity to `ruby`; accept only the shared seven-language vocabulary and the v1 capability `caller_cancellation`, and validate the fixture declaration against the shared capability table before any SDK call. `RecipeFactory` implements all eight property recipes: Ruby `Float::NAN`, both infinities, both unsafe integers, a self-referential array/hash cycle, a non-string-key hash, and an unsupported `Object.new`. Expand the body recipe by UTF-8 bytes until `minimum_utf8_bytes`, then append `suffix`. Unknown or malformed fields fail before any SDK call.

- [ ] **Step 3: Implement mock controls, operation dispatch, and assertions**
  `MockControlClient` uses only `CEKAT_CONFORMANCE_CONTROL_URL`, sends an empty body to `/__control/reset`, sends `{"responses":[...]}` to `/__control/responses`, and validates/unwraps `{"requests":[...]}` from `/__control/requests`. For each case reset, queue expanded responses, construct `Client` with `CEKAT_CONFORMANCE_BASE_URL`, `CEKAT_CONFORMANCE_ACCESS_TOKEN`, and fixture timeout/retry overrides, establish inbound/ambient state, and dispatch all five operations. Assert exact result class, attempts, certainty, HTTP status/code/message, acknowledgement, retained UTF-8 body behavior, jitter bounds, request count, fixed path/auth, and payload. Validation recipes assert zero journal entries.

- [ ] **Step 4: Classify schema-declared Ruby cancellation inapplicability**
  The approved first-release Ruby API keeps configured Net::HTTP request timeouts but has no portable caller-cancellation primitive; do not add one. Discover and schema-validate all three cancellation cases. For each, verify `requires_capabilities` is exactly `["caller_cancellation"]`, verify `inapplicable_languages` explicitly contains `ruby` and equals the shared capability-derived set, and emit one machine-readable line such as `{"id":"cancellation-before-request","status":"not_applicable","capability":"caller_cancellation","reason":"ruby-v1-no-caller-cancellation"}`. Include those IDs in discovered and `not_applicable` accounting, never in passed accounting. This is a schema-declared classification, not a skip, pending, unsupported result, pass, or silent omission. Any Ruby `not_applicable` claim absent from the fixture, or any cancellation fixture that omits Ruby, is a conformance failure.

- [ ] **Step 5: Enforce exhaustive accounting and the exact four-variable script**
  After execution compare discovered IDs with the disjoint union of asserted-pass IDs and schema-declared `not_applicable` IDs; fail on duplicates, unaccounted cases, unknown forms, undeclared inapplicability, or any ordinary RSpec skip/pending outcome. Exit `0` when every applicable case passed and every inapplicable case was validated and classified exactly once. The POSIX script uses `set -eu`, rejects positional arguments, requires the four exact non-empty names, rejects every other `CEKAT_CONFORMANCE_*` variable, validates both URLs as absolute HTTP(S) origins without user info/path/query/fragment, and validates the fixture value as an absolute readable directory. It does not start the server, infer a repository fixture path, or accept aliases/defaults. It runs `bundle exec rspec spec/conformance --format documentation`.

- [ ] **Step 6: Verify against the shared server**
  Run from repository root:
  ```bash
  ready="$(mktemp)"
  (cd conformance/mock-ingest-server && go run ./cmd/mock-ingest-server --listen 127.0.0.1:0 >"$ready") & pid=$!
  trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -f "$ready"' EXIT INT TERM
  while ! test -s "$ready"; do kill -0 "$pid"; sleep 0.1; done
  base_url="$(jq -er .base_url "$ready")"
  control_url="$(jq -er .control_url "$ready")"
  log="$(mktemp)"
  CEKAT_CONFORMANCE_BASE_URL="$base_url" \
  CEKAT_CONFORMANCE_CONTROL_URL="$control_url" \
  CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
  CEKAT_CONFORMANCE_FIXTURES="$(pwd)/conformance/fixtures/cases" \
    ruby/scripts/conformance >"$log" 2>&1
  cat "$log"
  test "$(grep -c '"status":"not_applicable"' "$log")" -eq 3
  test "$(grep -c 'ruby-v1-no-caller-cancellation' "$log")" -eq 3
  rm -f "$log"
  ```
  Expected: every applicable fixture passes exactly once, all three schema-declared cancellation cases are validated and reported `not_applicable` exactly once with Ruby explicitly excluded, no ordinary skip occurs, and the runner exits `0`.

- [ ] **Step 7: Commit**
  ```bash
  git add ruby/spec/conformance ruby/scripts/conformance
  git commit -m "test(ruby): run shared conformance fixtures"
  ```

### Task 7: Document Ruby limits and add the package contract
**Files:**
- Create: `ruby/README.md`
- Create: `ruby/scripts/package`
- Create: `ruby/spec/readme_contract_spec.rb`
- Create: `ruby/spec/package_script_spec.rb`
- Modify: `ruby/cekat-event-sdk.gemspec`

**Interfaces:**
- Consumes: all Ruby implementation. The later cross-language plan exclusively creates `ci/package-manifest.schema.json` and `scripts/validate-package-manifest.py`; this task does not invoke or depend on those future files.
- Produces `ruby/scripts/package --version 0.1.0 --output <absolute-dir>` and a closed manifest `{schema_version:1, language:"ruby", version:"0.1.0", artifacts:[{path,sha256,size_bytes}]}` for later root validation.

- [ ] **Step 1: Add failing documentation/package tests**
  Add `readme_contract_spec.rb` reading `README.md` and asserting queue-acceptance and duplicate-retry limitations, visitor trust, Rack/Rails setup, explicit visitor escape hatch, Net::HTTP timeouts, lack of portable caller cancellation, precise fiber/thread scope, and the evidence-derived Ruby/Rack/Rails matrix. Add `package_script_spec.rb` that parses produced JSON with duplicate-key rejection and asserts the exact closed top-level/artifact key sets, fixed schema/language/version values, non-empty complete artifact accounting (every regular output file except `manifest.json`, with no unlisted file), unique paths sorted by UTF-8 bytes, relative traversal-safe slash-separated paths, lowercase 64-hex SHA-256 values, exact byte sizes, and rejection of symlinks anywhere in output. Run `cd ruby && bundle exec rspec spec/readme_contract_spec.rb spec/package_script_spec.rb && test -x scripts/package`.
  Expected: failure because README and package script are absent.
- [ ] **Step 2: Write documentation and package script**
  Document only compatibility claims in `ruby/COMPATIBILITY.md`; do not imply ambient visitor state crosses arbitrary threads/fibers. The package script accepts only version `0.1.0`, requires an absolute absent-or-empty output directory, runs unit/framework specs (conformance is a separate live-server gate), builds/copies one gem, and atomically writes `manifest.json` satisfying the self-contained package contract tests. Reject signing and publication; never call `gem push`.
- [ ] **Step 3: Verify all evidenced contexts and package output**
  Run:
  ```bash
  cd ruby
  bundle exec rspec --exclude-pattern 'spec/conformance/**/*_spec.rb'
  while IFS= read -r appraisal; do
    bundle exec appraisal "$appraisal" rspec spec/rack spec/rails || exit 1
  done < <(awk '/^(Rack|Rails) appraisal:/ {print $3}' COMPATIBILITY.md | sort -u)
  gem build cekat-event-sdk.gemspec
  gem specification cekat-event-sdk-0.1.0.gem name version files
  output="$(mktemp -d)"
  scripts/package --version 0.1.0 --output "$output"
  bundle exec rspec spec/package_script_spec.rb
  ```
  Expected: evidenced unit/framework profiles pass, one `0.1.0` gem is inspectable, and the self-contained package specs prove exact manifest shape, sorted safe paths, hashes, sizes, complete file accounting, and symlink rejection without signing/publication. Root manifest validation is applied later by the cross-language CI/release plan.
- [ ] **Step 4: Commit**
  ```bash
  git add ruby
  git commit -m "docs(ruby): document adapters and package checks"
  ```

### Task 8: Run the release-time compatibility and acceptance gate
**Files:**
- Modify only if fresh evidence differs: `ruby/COMPATIBILITY.md`, `ruby/Gemfile.lock`, `ruby/Appraisals`, `ruby/cekat-event-sdk.gemspec`

- [ ] **Step 1: Repeat Task 1 official-source checks immediately before release readiness**
  Record a dated release-verification section with current Ruby maintenance status and RubyGems metadata for Bundler, Rack, Rails, RSpec, and WebMock. If a selected line is no longer maintained/compatible or metadata changed, stop; update dependencies and appraisal/CI pairings through review and rerun all checks rather than silently preserving or upgrading claims.
- [ ] **Step 2: Run both Ruby runtime profiles and every evidenced framework pairing**
  Under the exact minimum and current stable Ruby versions recorded in `ruby/COMPATIBILITY.md`, run `bundle install`, all non-conformance specs, each recorded Appraisal, package creation/self-contained manifest assertions, and the live conformance command. Expected: ordinary tests/package checks pass; all applicable shared cases pass; the three cancellation cases are schema-validated and reported `not_applicable`; no skip/pending result occurs; and the conformance runner exits `0`. The root manifest validator is applied later by the cross-language CI/release plan.
- [ ] **Step 3: Commit evidence only when changed**
  ```bash
  git add ruby/COMPATIBILITY.md ruby/Gemfile.lock ruby/Appraisals ruby/cekat-event-sdk.gemspec
  git commit -m "docs(ruby): refresh compatibility evidence"
  ```
  Make no empty commit.
---
