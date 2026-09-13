# frozen_string_literal: true

require "spec_helper"
require "bigdecimal"
require "date"

RSpec.describe CekatEventSdk::PayloadBuilder do
  subject(:builder) do
    described_class.new(clock: -> { Time.utc(2026, 9, 13, 1, 15, 30, 250_999) }, id_generator: -> { "generated-event-id" })
  end

  let(:uuid_v4) { /\A\h{8}-\h{4}-4\h{3}-[89ab]\h{3}-\h{12}\z/ }

  def build(event, key: "user_login", common: true, ambient: nil)
    JSON.parse(builder.build(key, common, event, ambient))
  end

  def expect_invalid(message, &)
    expect(&).to raise_error(CekatEventSdk::ValidationError, a_string_including(message))
  end

  def input(**attributes)
    CekatEventSdk::EventInput.new(email: "ada@example.test", **attributes)
  end

  it "builds the exact payload, preserving identity whitespace and trimming the visitor" do
    event = CekatEventSdk::EventInput.new(email: " ada@example.test ", phone_number: " +628123 ", contact_name: " Ada ",
                                          visitor_id: " explicit\t", properties: { nested: ["value", 12.5, nil] })
    expect(build(event, key: " custom_event ", common: false, ambient: " ambient ")).to eq(
      "event_key" => " custom_event ", "event_id" => "generated-event-id", "occurred_at" => "2026-09-13T01:15:30.250Z",
      "is_common" => false, "email" => " ada@example.test ", "phone_number" => " +628123 ", "contact_name" => " Ada ",
      "visitor_id" => "explicit", "properties" => { "nested" => ["value", 12.5, nil] }
    )
  end

  it "falls back from a blank explicit visitor to the ambient visitor and omits absent optionals" do
    expect(build(input(visitor_id: " "), ambient: " ambient ")["visitor_id"]).to eq("ambient")
    expect(build(input, ambient: "\t").keys).to eq(%w[event_key event_id occurred_at is_common email])
  end

  it "rejects blank keys, missing identity, non-string fields, and non-EventInput events" do
    expect_invalid("event key") { builder.build(" \t", true, input, nil) }
    expect_invalid("event key") { builder.build(nil, true, input, nil) }
    expect_invalid("email or phone number") { builder.build("user_login", true, CekatEventSdk::EventInput.new(email: " ", phone_number: "\n"), nil) }
    expect_invalid("email must be a String") { builder.build("user_login", true, CekatEventSdk::EventInput.new(email: 42), nil) }
    expect_invalid("EventInput") { builder.build("user_login", true, { email: "a@b.c" }, nil) }
    expect(build(CekatEventSdk::EventInput.new(phone_number: "+62"))["phone_number"]).to eq("+62")
  end

  it "trims caller event IDs and serializes caller times as UTC milliseconds" do
    payload = build(input(event_id: " order-1 ", occurred_at: Time.new(2026, 9, 13, 8, 15, 30.250999r, "+07:00")))
    expect(payload.values_at("event_id", "occurred_at")).to eq(["order-1", "2026-09-13T01:15:30.250Z"])
    expect(build(input(occurred_at: DateTime.new(2026, 9, 13, 8, 15, 30.25r, "+07:00")))["occurred_at"]).to eq("2026-09-13T01:15:30.250Z")
    expect_invalid("occurred_at must be a Time") { build(input(occurred_at: "2026-09-13")) }
    expect_invalid("between years") { build(input(occurred_at: Time.utc(10_000))) }
  end

  it "generates a distinct lowercase UUID and the call time by default" do
    default_builder = described_class.new
    before = Time.now
    first = JSON.parse(default_builder.build("user_login", true, input(event_id: " "), nil))
    second = JSON.parse(default_builder.build("user_login", true, input, nil))
    expect(first["event_id"]).to match(uuid_v4)
    expect(first["event_id"]).not_to eq(second["event_id"])
    occurred = Time.iso8601(first["occurred_at"])
    expect(occurred).to be_between(before - 1, Time.now + 1)
  end

  it "normalizes symbols, safe numbers, and nested containers" do
    properties = { plan: :pro, "count" => 9_007_199_254_740_991, decimal: BigDecimal("12.50"), ratio: 1/4r, list: [], empty: {} }
    expect(build(input(properties: properties))["properties"]).to eq(
      "plan" => "pro", "count" => 9_007_199_254_740_991, "decimal" => 12.5, "ratio" => 0.25, "list" => [], "empty" => {}
    )
    shared = { "value" => "reused" }
    expect(build(input(properties: { first: shared, second: shared }))["properties"]).to eq("first" => shared, "second" => shared)
  end

  {
    "NaN" => [{ risk: Float::NAN }, "properties.risk"],
    "infinity" => [{ risk: -Float::INFINITY }, "properties.risk"],
    "unsafe integer" => [{ id: 9_007_199_254_740_992 }, "properties.id"],
    "unsafe integral float" => [{ id: 9_007_199_254_740_992.0 }, "properties.id"],
    "nested unsafe integer" => [{ order: { items: [1, -2**60] } }, "properties.order.items[1]"],
    "non-finite BigDecimal" => [{ total: BigDecimal("NaN") }, "properties.total"],
    "complex number" => [{ value: Complex(1, 2) }, "properties.value"],
    "integer key" => [{ map: { 1 => "one" } }, "Integer key"],
    "duplicate key after conversion" => [{ :a => 1, "a" => 2 }, "duplicate key"],
    "arbitrary object" => [{ when: Object.new }, "properties.when"],
    "Time value" => [{ when: Time.now }, "properties.when"],
    "invalid UTF-8" => [{ text: "\xB1\x31".b }, "UTF-8"]
  }.each do |name, (properties, message)|
    it "rejects #{name}" do
      expect_invalid(message) { build(input(properties: properties)) }
    end
  end

  it "rejects cycles and non-Hash properties" do
    cycle = {}
    cycle[:self] = cycle
    list_cycle = []
    list_cycle << list_cycle
    expect_invalid("cycle") { build(input(properties: cycle)) }
    expect_invalid("cycle") { build(input(properties: { items: list_cycle })) }
    expect_invalid("must be a Hash") { build(input(properties: ["value"])) }
  end

  describe ".with_order_paid_properties" do
    it "merges amount and currency without mutating caller properties" do
      properties = { order_id: "ord-1" }
      merged = described_class.with_order_paid_properties(BigDecimal("125000"), " IDR ", input(properties: properties))
      expect(build(merged)["properties"]).to eq("order_id" => "ord-1", "amount" => 125_000.0, "currency" => " IDR ")
      expect(properties).to eq(order_id: "ord-1")
      expect(build(described_class.with_order_paid_properties(12, "USD", input))["properties"]).to eq("amount" => 12, "currency" => "USD")
    end

    it "rejects invalid arguments and conflicting properties" do
      expect_invalid("amount") { described_class.with_order_paid_properties(Float::NAN, "IDR", input) }
      expect_invalid("amount") { described_class.with_order_paid_properties("125", "IDR", input) }
      expect_invalid("currency") { described_class.with_order_paid_properties(1, " ", input) }
      expect_invalid("currency") { described_class.with_order_paid_properties(1, :idr, input) }
      expect_invalid('"amount"') { described_class.with_order_paid_properties(1, "IDR", input(properties: { amount: 2 })) }
      expect_invalid('"currency"') { described_class.with_order_paid_properties(1, "IDR", input(properties: { "currency" => "USD" })) }
      expect_invalid("properties.amount") { build(described_class.with_order_paid_properties(1e16, "IDR", input)) }
    end
  end
end
