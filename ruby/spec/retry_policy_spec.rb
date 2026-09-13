# frozen_string_literal: true

require "spec_helper"

RSpec.describe CekatEventSdk::RetryPolicy do
  it "classifies retryable statuses and caps exponential jitter bounds" do
    expect([429, 500, 502, 503, 504].all? { |status| described_class.retryable_status?(status) }).to be(true)
    expect([200, 400, 401, 404, 409, 422, 501].none? { |status| described_class.retryable_status?(status) }).to be(true)
    expect([1, 2, 3, 4, 5, 6, 1_000_000].map { |retry_number| described_class.delay_bound_ms(retry_number) })
      .to eq([100, 200, 400, 800, 1000, 1000, 1000])
  end

  it "parses Retry-After delta-seconds and HTTP-dates only" do
    now = Time.utc(2026, 9, 13, 1).to_i * 1000
    expect(described_class.parse_retry_after_ms(nil, now)).to be_nil
    expect(described_class.parse_retry_after_ms(" 3 ", now)).to eq(3000)
    expect(described_class.parse_retry_after_ms("0", now)).to eq(0)
    expect(described_class.parse_retry_after_ms("99999999999999999999", now)).to eq(Float::INFINITY)
    expect(described_class.parse_retry_after_ms("Sun, 13 Sep 2026 01:00:04 GMT", now)).to eq(4000)
    expect(described_class.parse_retry_after_ms("Sun, 13 Sep 2026 00:59:00 GMT", now)).to eq(0)
    ["-1", "1.5", "Sun 13 Sep 2026", "tomorrow", ""].each do |value|
      expect(described_class.parse_retry_after_ms(value, now)).to be_nil
    end
  end
end
