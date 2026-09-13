# frozen_string_literal: true

require "spec_helper"

RSpec.describe CekatEventSdk::VisitorContext do
  it "nests scopes and restores the previous value after return and exceptions" do
    observed = described_class.with(" outer ") do
      inner = described_class.with("inner") { described_class.current_visitor_id }
      blank = described_class.with(" \t") { described_class.current_visitor_id }
      [described_class.current_visitor_id, inner, blank]
    end
    expect(observed).to eq(["outer", "inner", nil])
    expect { described_class.with("failing") { raise "handler failed" } }.to raise_error(RuntimeError, "handler failed")
    expect(described_class.current_visitor_id).to be_nil
  end

  it "isolates interleaved fibers without thread-local state" do
    first = Fiber.new do
      described_class.with("visitor-a") do
        Fiber.yield
        described_class.current_visitor_id
      end
    end
    second = Fiber.new do
      described_class.with("visitor-b") do
        Fiber.yield
        described_class.current_visitor_id
      end
    end
    first.resume
    second.resume
    expect(first.resume).to eq("visitor-a")
    expect(second.resume).to eq("visitor-b")
    expect(described_class.current_visitor_id).to be_nil
    expect(Thread.current.keys).not_to include(described_class::STORAGE_KEY)
  end

  it "isolates concurrent threads and copies the scope into threads started inside it" do
    results = Array.new(20) do |index|
      Thread.new { described_class.with("visitor-#{index}") { sleep(rand / 100) && described_class.current_visitor_id } }
    end.map(&:value)
    expect(results).to eq(Array.new(20) { |index| "visitor-#{index}" })
    inherited = described_class.with("parent") { Thread.new { described_class.current_visitor_id }.value }
    expect(inherited).to eq("parent")
  end
end

RSpec.describe CekatEventSdk::VisitorIdResolver do
  it "prefers the header, trims values, and parses raw cookie headers without unescaping" do
    expect(described_class.from_header_and_cookie(header: " header ", cookie: "cookie")).to eq("header")
    expect(described_class.from_header_and_cookie(header: " \t", cookie: " cookie ")).to eq("cookie")
    expect(described_class.from_header_and_cookie(header: nil, cookie: " ")).to be_nil
    expect(described_class.from_cookie_header("x_cekat_visitor_id=no; _cekat_visitor_id=a%20b")).to eq("a%20b")
    expect(described_class.from_cookie_header("malformed; other=1")).to be_nil
    expect(described_class.from_rack_env("HTTP_COOKIE" => "_cekat_visitor_id= cookie ")).to eq("cookie")
    expect(described_class.from_rack_env("HTTP_X_CEKAT_VISITOR_ID" => "header", "HTTP_COOKIE" => "_cekat_visitor_id=cookie")).to eq("header")
  end
end
