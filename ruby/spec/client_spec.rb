# frozen_string_literal: true

require "spec_helper"

RSpec.describe CekatEventSdk::Client do
  let(:token) { "token-that-must-not-leak" }

  let(:sleeps) { [] }
  let(:bounds) { [] }
  let(:random) do
    recorded = bounds
    Object.new.tap { |object| object.define_singleton_method(:rand) { |limit| (recorded << (limit - 1)) && 0 } }
  end

  def client(transport, **options)
    recorded = sleeps
    described_class.new(access_token: token, base_url: "https://ingest.example.test/", transport: transport,
                        sleeper: ->(seconds) { recorded << (seconds * 1000).round }, random: random, **options)
  end

  it "posts the fixed endpoint with authorization, content type, and user agent" do
    transport = FakeTransport.new
    ack = client(transport).user_login(email: "ada@example.test")

    expect(ack.message).to eq("accepted")
    request = transport.requests.first
    expect(request[:uri]).to eq("https://ingest.example.test/api/events/ingest")
    expect(request[:headers]).to eq("Authorization" => "Bearer #{token}", "Content-Type" => "application/json",
                                    "User-Agent" => "cekat-event-sdk-ruby/#{CekatEventSdk::VERSION} ruby/#{RUBY_VERSION}")
    expect(request[:timeout]).to eq(3)
    expect(transport.payload).not_to have_key("business_id")
  end

  it "maps every operation to its key, common flag, and order_paid arguments" do
    transport = FakeTransport.new
    subject = client(transport)
    event = CekatEventSdk::EventInput.new(email: "ada@example.test", properties: { order: "A-1" })
    subject.user_registration(event)
    subject.user_login({ email: "ada@example.test", properties: { order: "A-1" } })
    subject.order_created(email: "ada@example.test", properties: { order: "A-1" })
    subject.form_submitted(event)
    subject.order_paid(event, amount: 125.75, currency: "IDR")
    subject.custom_event("trial_started", event)

    summary = 6.times.map { |index| transport.payload(index).values_at("event_key", "is_common", "properties") }
    order = { "order" => "A-1" }
    expect(summary).to eq([
                            ["user_registration", true, order],
                            ["user_login", true, order],
                            ["order_created", true, order],
                            ["form_submitted", true, order],
                            ["order_paid", true, order.merge("amount" => 125.75, "currency" => "IDR")],
                            ["trial_started", false, order]
                          ])
  end

  it "validates configuration and input before any request" do
    transport = FakeTransport.new
    subject = client(transport)
    [
      -> { subject.user_login(contact_name: "Ada") },
      -> { subject.user_login(email: "a@b.c", unknown: 1) },
      -> { subject.user_login(CekatEventSdk::EventInput.new(email: "a@b.c"), email: "a@b.c") },
      -> { subject.user_login("a@b.c") },
      -> { subject.custom_event(" ", email: "a@b.c") },
      -> { subject.order_paid(email: "a@b.c", amount: Float::INFINITY, currency: "IDR") },
      -> { subject.order_paid(email: "a@b.c", amount: 1, currency: " ") },
      -> { subject.order_paid(email: "a@b.c", properties: { currency: "USD" }, amount: 1, currency: "IDR") }
    ].each { |call| expect(&call).to raise_error(CekatEventSdk::ValidationError) }
    expect(transport.requests).to be_empty

    [
      { access_token: " " }, { access_token: nil }, { timeout: 0 }, { timeout: Float::INFINITY }, { retry_count: -1 }, { retry_count: 1.5 },
      { base_url: "server.cekat.ai" }, { base_url: "ftp://server.cekat.ai" }, { base_url: "https://user:pass@server.cekat.ai" },
      { base_url: "https://server.cekat.ai/events" }, { base_url: "https://server.cekat.ai/?q" }, { base_url: "https://server.cekat.ai/#x" }
    ].each do |options|
      expect { described_class.new(access_token: token, **options) }.to raise_error(CekatEventSdk::ValidationError)
    end
    expect(described_class.new(access_token: token, base_url: "HTTP://127.0.0.1:8080/").base_url).to eq("http://127.0.0.1:8080")
    expect(described_class.new(access_token: token).base_url).to eq("https://server.cekat.ai")
  end

  it "uses the visitor scope with explicit visitor precedence" do
    transport = FakeTransport.new
    subject = client(transport)
    subject.with_visitor_id(" scoped ") do
      subject.user_login(email: "a@b.c")
      subject.user_login(email: "a@b.c", visitor_id: " explicit ")
      subject.user_login(email: "a@b.c", visitor_id: " ")
    end
    subject.user_login(email: "a@b.c")
    custom = Struct.new(:current_visitor_id).new("custom")
    client(transport, visitor_context: custom).user_login(email: "a@b.c")

    expect(5.times.map { |index| transport.payload(index)["visitor_id"] }).to eq(["scoped", "explicit", "scoped", nil, "custom"])
  end

  [429, 500, 502, 503, 504].each do |status|
    it "retries transient status #{status} with an identical body" do
      transport = FakeTransport.new([FakeTransport.response(status, "transient"), FakeTransport.success])
      client(transport).order_paid(email: "a@b.c", amount: 1, currency: "IDR")
      expect(transport.requests.size).to eq(2)
      expect(transport.requests.map { |request| request[:body] }.uniq.size).to eq(1)
    end
  end

  it "does not retry permanent statuses" do
    [400, 401, 404, 409, 422, 501].each do |status|
      transport = FakeTransport.new([FakeTransport.response(status, '{"success":false,"error":"permanent"}')])
      expect { client(transport).user_login(email: "a@b.c") }.to raise_error(CekatEventSdk::ApiError) { |error|
        expect(error).to have_attributes(status: status, attempts: 1)
      }
      expect(transport.requests.size).to eq(1)
    end
    expect(sleeps).to be_empty
  end

  it "exhausts retries using capped exponential jitter bounds" do
    transport = FakeTransport.new(Array.new(7) { FakeTransport.response(500, '{"success":false,"error":"temporary"}') })
    expect { client(transport, retry_count: 6).user_login(email: "a@b.c") }.to raise_error(CekatEventSdk::ApiError) { |error|
      expect(error).to have_attributes(attempts: 7, status: 500)
    }
    expect(bounds).to eq([100, 200, 400, 800, 1000, 1000])
  end

  it "retries transport failures and reports an unknown outcome without leaking the token" do
    transport = FakeTransport.new([
                                    CekatEventSdk::Transport::Failure.new("Errno::ECONNRESET: reset"),
                                    FakeTransport.response(503, ""),
                                    CekatEventSdk::Transport::Failure.new("Net::ReadTimeout: final")
                                  ])
    subject = client(transport)
    expect { subject.user_login(email: "a@b.c") }.to raise_error(CekatEventSdk::TransportError) { |error|
      expect(error).to have_attributes(attempts: 3, delivery_outcome_unknown?: true)
      expect(error.cause.message).to include("final")
      expect([error.message, error.inspect, error.cause.inspect, subject.inspect, subject.to_s].join).not_to include(token)
    }
  end

  it "raises Retry-After delays and stops beyond five seconds" do
    transport = FakeTransport.new([
                                    FakeTransport.response(429, "slow", headers: { "retry-after" => "2" }),
                                    FakeTransport.response(503, "slow", headers: { "Retry-After" => "soon" }),
                                    FakeTransport.success
                                  ])
    client(transport).user_login(email: "a@b.c")
    expect(sleeps).to eq([2000, 0])

    capped = FakeTransport.new([FakeTransport.response(503, "maintenance", headers: { "Retry-After" => "6" }, reason: "Service Unavailable")])
    expect { client(capped).user_login(email: "a@b.c") }.to raise_error(CekatEventSdk::ApiError) { |error|
      expect(error).to have_attributes(status: 503, attempts: 1, message: "Service Unavailable")
    }
    expect(capped.requests.size).to eq(1)
  end

  it "never retries an accepted 200 whose body read failed, but retries a retryable status" do
    failure = CekatEventSdk::Transport::Failure.new("EOFError: end of file reached")
    accepted = FakeTransport.new([FakeTransport.response(200, '{"success":tr', failure: failure)])
    expect { client(accepted).user_login(email: "a@b.c") }.to raise_error(CekatEventSdk::ResponseDecodeError) { |error|
      expect(error).to have_attributes(attempts: 1, delivery_outcome_unknown?: false)
    }
    expect(accepted.requests.size).to eq(1)

    retryable = FakeTransport.new([FakeTransport.response(500, "", failure: failure), FakeTransport.success])
    client(retryable).user_login(email: "a@b.c")
    expect(retryable.requests.size).to eq(2)
  end
end
