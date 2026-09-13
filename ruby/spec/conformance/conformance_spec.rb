# frozen_string_literal: true

require "spec_helper"
require "json"
require "json_schemer"
require "net/http"
require "pathname"
require "time"

# Executes every shared fixture against the mock ingest server, driven only by the four
# CEKAT_CONFORMANCE_* variables that scripts/conformance validates.
RSpec.describe "Shared conformance" do
  required_env = %w[CEKAT_CONFORMANCE_BASE_URL CEKAT_CONFORMANCE_CONTROL_URL CEKAT_CONFORMANCE_ACCESS_TOKEN CEKAT_CONFORMANCE_FIXTURES].freeze
  event_id_pattern = /\A\h{8}-\h{4}-4\h{3}-[89ab]\h{3}-\h{12}\z/
  occurred_at_pattern = /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\z/
  user_agent_pattern = %r{\Acekat-event-sdk-ruby/\d+\.\d+\.\d+\S*( .+)?\z}

  # Records the transport response so body byte accounting can be asserted.
  recording_transport = Class.new do
    attr_reader :last

    def initialize(inner)
      @inner = inner
    end

    def post(**)
      @last = @inner.post(**)
    end
  end

  define_method(:schemas) do |directory|
    @schemas ||= begin
      resolver = lambda do |uri|
        JSON.parse(File.read(File.join(directory, File.basename(uri.path))))
      end
      %w[conformance-case request-journal].to_h do |name|
        path = Pathname.new(File.join(directory, "#{name}.schema.json"))
        [name, JSONSchemer.schema(path, ref_resolver: resolver)]
      end
    end
  end

  define_method(:control) do |method, path, body = nil|
    uri = URI("#{ENV.fetch('CEKAT_CONFORMANCE_CONTROL_URL')}#{path}")
    request = method == :get ? Net::HTTP::Get.new(uri) : Net::HTTP::Post.new(uri)
    if body
      request["Content-Type"] = "application/json"
      request.body = JSON.generate(body)
    end
    Net::HTTP.start(uri.host, uri.port) { |http| http.request(request) }
  end

  define_method(:expand_body) do |recipe|
    body = +""
    body << recipe.fetch("unit") while body.bytesize < recipe.fetch("minimum_utf8_bytes")
    body << recipe.fetch("suffix")
  end

  define_method(:recipe_properties) do |recipe|
    case recipe
    when "nan" then { "value" => Float::NAN }
    when "positive_infinity" then { "value" => Float::INFINITY }
    when "negative_infinity" then { "value" => -Float::INFINITY }
    when "unsafe_integer_high" then { "value" => 9_007_199_254_740_992 }
    when "unsafe_integer_low" then { "value" => -9_007_199_254_740_992 }
    when "cycle" then {}.tap { |value| value["self"] = value }
    when "non_string_key" then { "value" => { 1 => "one" } }
    when "runtime_object" then { "value" => Object.new }
    else raise "unknown properties recipe #{recipe}"
    end
  end

  define_method(:dispatch) do |client, operation|
    source = operation.fetch("event")
    properties = operation.key?("properties_recipe") ? recipe_properties(operation["properties_recipe"]) : source["properties"]
    event = CekatEventSdk::EventInput.new(
      email: source["email"], phone_number: source["phone_number"], contact_name: source["contact_name"],
      visitor_id: source["visitor_id"], properties: properties, event_id: source["event_id"],
      occurred_at: source["occurred_at"] && Time.iso8601(source["occurred_at"])
    )
    case operation.fetch("name")
    when "user_registration" then client.user_registration(event)
    when "user_login" then client.user_login(event)
    when "order_created" then client.order_created(event)
    when "order_paid" then client.order_paid(event, amount: operation.fetch("amount"), currency: operation.fetch("currency"))
    when "custom_event" then client.custom_event(operation.fetch("event_key"), event)
    else raise "unknown operation #{operation['name']}"
    end
  end

  define_method(:canonical) do |value|
    case value
    when Hash then { "object" => value.sort.to_h { |key, item| [key, canonical(item)] } }
    when Array then { "list" => value.map { |item| canonical(item) } }
    when Integer then value.to_f
    else value
    end
  end

  define_method(:execute) do |fixture, fixtures_directory|
    fixture.fetch("id")
    expect(control(:post, "/__control/reset").code).to eq("204")
    responses = (fixture["responses"] || []).map(&:dup)
    expanded = fixture["response_body_recipe"] && expand_body(fixture["response_body_recipe"])
    if expanded
      expect(responses.size).to eq(1)
      responses[0]["body"] = expanded
    end
    expect(control(:post, "/__control/responses", { "responses" => responses }).code).to eq("204")

    sleeps = []
    transport = recording_transport.new(CekatEventSdk::Transport.new)
    client_options = fixture["client"] || {}
    client = CekatEventSdk::Client.new(
      access_token: ENV.fetch("CEKAT_CONFORMANCE_ACCESS_TOKEN"), base_url: ENV.fetch("CEKAT_CONFORMANCE_BASE_URL"),
      timeout: client_options.key?("timeout_ms") ? client_options["timeout_ms"] / 1000.0 : 3,
      retry_count: client_options.fetch("retry_count", 2), transport: transport,
      sleeper: ->(seconds) { sleeps << (seconds * 1000).round }, random: Object.new.tap { |r| r.define_singleton_method(:rand) { |n| (n - 1) / 2 } }
    )

    inbound = fixture["inbound"] || {}
    started = Time.now
    result = nil
    error = nil
    begin
      invoke = -> { dispatch(client, fixture.fetch("operation")) }
      if inbound.key?("header_visitor_id") || inbound.key?("cookie_visitor_id")
        env = {}
        env["HTTP_X_CEKAT_VISITOR_ID"] = inbound["header_visitor_id"] if inbound.key?("header_visitor_id")
        env["HTTP_COOKIE"] = "_cekat_visitor_id=#{inbound['cookie_visitor_id']}" if inbound.key?("cookie_visitor_id")
        middleware = CekatEventSdk::Rack::Middleware.new(->(_env) { [200, {}, [invoke.call]] })
        result = middleware.call(env)[2].first
      elsif inbound.key?("ambient_visitor_id")
        result = CekatEventSdk::VisitorContext.with(inbound["ambient_visitor_id"]) { invoke.call }
      else
        result = invoke.call
      end
    rescue CekatEventSdk::Error => e
      error = e
    end
    finished = Time.now

    assert_result(fixture, result, error, transport, expanded)
    assert_delays(fixture.fetch("expect"), sleeps)
    assert_journal(fixture, fixtures_directory, started, finished)
  end

  define_method(:assert_result) do |fixture, result, error, transport, expanded|
    expected = fixture.fetch("expect")
    id = fixture.fetch("id")
    token = ENV.fetch("CEKAT_CONFORMANCE_ACCESS_TOKEN")
    expect("#{error&.message}#{error&.cause&.message}").not_to include(token) if error
    if expected.fetch("result") == "acknowledgement"
      expect(error).to be_nil, "#{id}: #{error&.class} #{error&.message}"
      expect(result).to be_a(CekatEventSdk::Acknowledgement)
      if (ack = expected["acknowledgement"])
        expect(result.to_h.slice(:message, :event_key, :validated_properties))
          .to eq(message: ack["message"], event_key: ack["event_key"], validated_properties: ack["validated_properties"])
      end
    else
      klass = {
        "validation_error" => CekatEventSdk::ValidationError, "authentication_error" => CekatEventSdk::AuthenticationError,
        "event_definition_not_found_error" => CekatEventSdk::EventDefinitionNotFoundError, "api_error" => CekatEventSdk::ApiError,
        "transport_error" => CekatEventSdk::TransportError, "response_decode_error" => CekatEventSdk::ResponseDecodeError
      }.fetch(expected["result"])
      expect(error&.class).to eq(klass), "#{id}: expected #{klass}, got #{error&.class} #{error&.message}"
      unless error.is_a?(CekatEventSdk::ValidationError)
        expect(error.attempts).to eq(expected["attempts"]), id
        expect(error.delivery_outcome_unknown?).to eq(expected.fetch("delivery_outcome_unknown", error.is_a?(CekatEventSdk::TransportError))), id
      end
      expect(error.status).to eq(expected["status"]), id if expected.key?("status")
      expect(error.message).to eq(expected["error_message"]), id if expected.key?("error_message")
      expect(error.message).to eq(expected["server_error"]), id if expected.key?("server_error")
      expect(error.code).to eq(expected["server_code"]), id if expected.key?("server_code")
      if expected.key?("retained_body_bytes")
        expect(error.raw_body.bytesize).to eq(expected["retained_body_bytes"]), id
        expect(error.raw_body.b).to eq(expanded.b.byteslice(0, expected["retained_body_bytes"])), id if expanded
      end
    end
    return unless expected.key?("observed_body_bytes") || expected.key?("body_truncated")

    expect(transport.last.observed_body_bytes).to eq(expected["observed_body_bytes"]), id
    expect(transport.last.body_truncated).to eq(expected["body_truncated"]), id
  end

  define_method(:assert_delays) do |expected, sleeps|
    if (bounds = expected["jitter_bounds_ms"])
      expect(sleeps.size).to eq(bounds.size)
      bounds.each_with_index { |(minimum, maximum), index| expect(sleeps[index]).to be_between(minimum, maximum) }
    end
    if (minimums = expected["minimum_retry_delays_ms"])
      expect(sleeps.size).to eq(minimums.size)
      minimums.each_with_index { |minimum, index| expect(sleeps[index]).to be >= minimum }
    end
  end

  define_method(:assert_journal) do |fixture, fixtures_directory, started, finished|
    id = fixture.fetch("id")
    expected = fixture.fetch("expect")
    response = control(:get, "/__control/requests")
    expect(response.code).to eq("200")
    journal = JSON.parse(response.body)
    expect(schemas(File.join(File.dirname(fixtures_directory), "schemas")).fetch("request-journal").valid?(journal)).to be(true), "#{id}: journal schema"
    requests = journal.fetch("requests")
    expect(requests.size).to eq(expected.fetch("attempts")), id

    generated = {}
    requests.each_with_index do |entry, index|
      expect(entry.dig("headers", "user-agent")&.size).to eq(1), id
      expect(entry["headers"]["user-agent"].first).to match(user_agent_pattern)
      next unless (request = expected["request"])

      expect(entry.values_at("sequence", "method", "path")).to eq([index + 1, "POST", request["path"]]), id
      expect(entry.dig("headers", "authorization")).to eq([request["authorization"]]), id
      actual = JSON.parse(entry["body"])
      %w[event_id occurred_at].each do |field|
        next if request["payload"].key?(field)

        value = actual.delete(field)
        expect(value).to be_a(String), "#{id}: #{field}"
        if field == "event_id"
          expect(value).to match(event_id_pattern)
        else
          expect(value).to match(occurred_at_pattern)
          expect(Time.iso8601(value)).to be_between(started - 1, finished + 1)
        end
        expect(value).to eq(generated[field]), "#{id}: #{field} reused" if generated.key?(field)
        generated[field] = value
      end
      expect(canonical(actual)).to eq(canonical(request["payload"])), "#{id}: payload"
    end
  end

  it "rejects malformed fixtures through the shared schemas" do
    directory = File.expand_path("../../../conformance/fixtures", __dir__)
    schema = schemas(File.join(directory, "schemas")).fetch("conformance-case")
    fixture = JSON.parse(File.read(File.join(directory, "cases", "retry-500-500-success.json")))
    expect(schema.valid?(fixture)).to be(true)
    [
      ->(value) { value["responses"][0]["headers"] = 1 },
      ->(value) { value["expect"]["status"] = "400" },
      ->(value) { value["expect"]["request"]["extra"] = true },
      ->(value) { value["operation"].delete("currency") },
      ->(value) { value["expect"]["jitter_bounds_ms"] = [[0, 101], [0, 200]] }
    ].each do |mutate|
      invalid = JSON.parse(JSON.generate(fixture))
      mutate.call(invalid)
      expect(schema.valid?(invalid)).to be(false)
    end
  end

  it "executes every discovered fixture exactly once" do
    environment = required_env.to_h { |name| [name, ENV.fetch(name, "")] }
    missing = environment.select { |_name, value| value.empty? }.keys
    raise "missing #{missing.join(', ')}; run scripts/conformance" unless missing.empty?

    extra = ENV.keys.grep(/\ACEKAT_CONFORMANCE_/) - required_env
    raise "unrecognized conformance environment variables: #{extra.join(', ')}" unless extra.empty?

    directory = environment.fetch("CEKAT_CONFORMANCE_FIXTURES")
    raise "CEKAT_CONFORMANCE_FIXTURES must be an absolute directory" unless directory.start_with?("/") && File.directory?(directory)

    case_schema = schemas(File.join(File.dirname(directory), "schemas")).fetch("conformance-case")
    files = Dir.glob(File.join(directory, "*.json"))
    raise "fixture corpus contains no direct JSON files" if files.empty?

    discovered = []
    passed = []
    not_applicable = []
    files.each do |file|
      fixture = JSON.parse(File.read(file))
      errors = case_schema.validate(fixture).map { |detail| detail.fetch("error") }
      raise "#{File.basename(file)} violates the shared schema: #{errors.first(3).join('; ')}" unless errors.empty?
      raise "#{File.basename(file)}: filename/ID mismatch" unless fixture["id"] == File.basename(file, ".json")
      raise "duplicate fixture ID #{fixture['id']}" if discovered.include?(fixture["id"])

      discovered << fixture["id"]
      if fixture.dig("applicability", "inapplicable_languages")&.include?("ruby")
        raise "#{fixture['id']}: only cancellation fixtures may exclude ruby" unless fixture["kind"] == "cancellation"
        raise "#{fixture['id']}: unexpected capability" unless fixture.dig("applicability", "requires_capabilities") == ["caller_cancellation"]

        not_applicable << fixture["id"]
        $stdout.puts JSON.generate(id: fixture["id"], status: "not_applicable", capability: "caller_cancellation",
                                   reason: "ruby-v1-no-caller-cancellation")
        next
      end

      execute(fixture, directory)
      passed << fixture["id"]
      $stdout.puts JSON.generate(id: fixture["id"], status: "passed")
    end

    expect((passed + not_applicable).sort).to eq(discovered.sort)
  end
end
