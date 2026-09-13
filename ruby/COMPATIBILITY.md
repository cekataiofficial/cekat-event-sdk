# Ruby SDK compatibility evidence

Retrieved: 2026-09-13 (UTC).

## Official sources

- Ruby maintenance branches: <https://www.ruby-lang.org/en/downloads/branches/> and <https://endoflife.date/api/v1/products/ruby/>
- Rails maintenance policy: <https://rubyonrails.org/maintenance> and <https://endoflife.date/api/v1/products/rails/>
- RubyGems metadata: `https://rubygems.org/api/v1/gems/<gem>.json`, `https://rubygems.org/api/v1/versions/<gem>.json`, and `https://rubygems.org/api/v2/rubygems/<gem>/versions/<version>.json`
- Security advisories: `bundle-audit check --update` (ruby-advisory-db)

## Ruby

| Line | Status | End of life | Observed patch | `Fiber[]` / `Fiber[]=` |
| --- | --- | --- | --- | --- |
| 4.0 | normal maintenance | 2029-03-31 | 4.0.6 | available |
| 3.4 | normal maintenance | 2028-03-31 | 3.4.10 | available |
| 3.3 | security maintenance | 2027-03-31 | 3.3.12 | available |
| 3.2 | end of life | 2026-03-31 | 3.2.11 | — |

`required_ruby_version` is `>= 3.3.0`: the oldest maintained line. The visitor scope requires the fiber storage API (`Fiber[]`, Ruby 3.2+), verified on every tested interpreter.

## Frameworks

| Framework | Supported | Evidence |
| --- | --- | --- |
| Rails | 8.0, 8.1 | 8.1.3.1 (security support until 2027-10-10); 8.0.5.1 (security support until **2026-11-07**); both require Ruby >= 3.2.0. Rails 7.2 reached end of life on 2026-08-09. |
| Rack | 2.2, 3.1, 3.2 | 3.2.7, 3.1.22, and 2.2.24 were all released 2026-08-13. The middleware uses only the Rack env protocol, so the gem declares no Rack dependency. |

The gem has no runtime dependencies: it uses Ruby's default `json`, `net-http`, `securerandom`, `time`, and `uri` gems.

## Development dependencies (latest observed)

rspec 3.13.2, rubocop 1.91.0, json_schemer 2.5.0, bundler-audit 0.9.3, rake 13.4.2. Bundler 2.5.22 ships with Ruby 3.3.12 and 4.0.16 with Ruby 4.0.6.

## Execution matrix (2026-09-13)

Every row ran `rake spec` (core, Rack, transport, packaging, and Rails specs), RuboCop, and the shared conformance suite against `conformance/mock-ingest-server`: 54 cases passed and the 3 caller-cancellation cases were reported `not_applicable`.

| Ruby | Rails | Rack | json | Specs |
| --- | --- | --- | --- | --- |
| 3.3.12 | 8.0.5.1 | 2.2.24 | 2.21.2 | 65 core + 6 Rails passed |
| 3.4.10 | 8.1.3.1 | 3.1.22 | 3.0.2 | 65 core + 6 Rails passed |
| 4.0.6 | 8.1.3.1 | 3.2.7 | 3.0.2 | 65 core + 6 Rails passed |

The Rails 8.0 row pins `json` to 2.x (`JSON_VERSION="~> 2.7"`). Rails 8.0.5.1's `render json:` raises `ArgumentError: unknown keyword: quirks_mode` with json 3.0; this is a Rails 8.0/json 3 incompatibility, not an SDK constraint, and Rails 8.0 applications lock json 2.x. The SDK itself passes with json 2.21 and 3.0.

`scripts/package` passed on Ruby 4.0.6, including `bundle-audit check --update` with no vulnerabilities found.
