# frozen_string_literal: true

require_relative "lib/cekat_event_sdk/version"

Gem::Specification.new do |spec|
  spec.name = "cekat-event-sdk"
  spec.version = CekatEventSdk::VERSION
  spec.authors = ["Cekat"]
  spec.summary = "Submit identity-bearing Cekat events from Ruby backends with browser visitor correlation."
  spec.description = "Synchronous Cekat event client with Rack middleware and a Rails integration " \
                     "that attach the browser visitor ID of the current request automatically."
  spec.homepage = "https://github.com/cekataiofficial/cekat-event-sdk"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.3.0"

  spec.metadata["source_code_uri"] = "https://github.com/cekataiofficial/cekat-event-sdk/tree/main/ruby"
  spec.metadata["rubygems_mfa_required"] = "true"

  spec.files = Dir["lib/**/*.rb", "README.md", "COMPATIBILITY.md", "LICENSE"].sort
  spec.require_paths = ["lib"]
end
