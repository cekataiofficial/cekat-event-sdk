# frozen_string_literal: true

require "cekat_event_sdk"
require_relative "support/fake_transport"
require_relative "support/raw_http_server"

RSpec.configure do |config|
  config.expect_with(:rspec) { |expectations| expectations.include_chain_clauses_in_custom_matcher_descriptions = true }
  config.mock_with(:rspec) { |mocks| mocks.verify_partial_doubles = true }
  config.disable_monkey_patching!
  config.order = :random
  Kernel.srand config.seed
  config.raise_errors_for_deprecations!
end
