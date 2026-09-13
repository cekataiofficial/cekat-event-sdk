# frozen_string_literal: true

require "spec_helper"
require "rack"
require "rack/mock"

RSpec.describe CekatEventSdk::Rack::Middleware do
  def env_for(headers = {})
    Rack::MockRequest.env_for("/orders", { method: "POST", input: "{}" }.merge(headers))
  end

  it "scopes the header visitor, exposes it in env, and leaves the response untouched" do
    observed = nil
    app = lambda do |env|
      observed = [env[described_class::ENV_KEY], CekatEventSdk::VisitorContext.current_visitor_id]
      [201, { "x-downstream" => "preserved" }, ["ok"]]
    end
    env = env_for("HTTP_X_CEKAT_VISITOR_ID" => " header ", "HTTP_COOKIE" => "_cekat_visitor_id=cookie")
    status, headers, = described_class.new(app).call(env)

    expect(observed).to eq(%w[header header])
    expect([status, headers]).to eq([201, { "x-downstream" => "preserved" }])
    expect(env).not_to have_key(described_class::ENV_KEY)
    expect(CekatEventSdk::VisitorContext.current_visitor_id).to be_nil
  end

  it "falls back to the cookie and restores a prior env value" do
    observed = nil
    app = ->(env) { (observed = env[described_class::ENV_KEY]) && [200, {}, []] }
    env = env_for("HTTP_COOKIE" => "other=1; _cekat_visitor_id= cookie ")
    env[described_class::ENV_KEY] = "prior"
    described_class.new(app).call(env)
    expect(observed).to eq("cookie")
    expect(env[described_class::ENV_KEY]).to eq("prior")

    described_class.new(->(e) { (observed = e.fetch(described_class::ENV_KEY, :absent)) && [200, {}, []] }).call(env_for)
    expect(observed).to eq(:absent)
  end

  it "restores the outer scope when the app raises" do
    middleware = described_class.new(->(_env) { raise "downstream failure" })
    CekatEventSdk::VisitorContext.with("outer") do
      expect { middleware.call(env_for("HTTP_X_CEKAT_VISITOR_ID" => "inner")) }.to raise_error("downstream failure")
      expect(CekatEventSdk::VisitorContext.current_visitor_id).to eq("outer")
    end
  end

  it "isolates interleaved fiber requests and sends the right visitor through a Rack stack" do
    transport = FakeTransport.new
    client = CekatEventSdk::Client.new(access_token: "token", transport: transport)
    app = Rack::Builder.new do
      use CekatEventSdk::Rack::Middleware
      run(lambda do |_env|
        Fiber.yield
        client.user_login(email: "a@b.c")
        [204, {}, []]
      end)
    end.to_app
    fibers = %w[fiber-a fiber-b].map { |visitor| Fiber.new { app.call(env_for("HTTP_X_CEKAT_VISITOR_ID" => visitor)) } }
    fibers.each(&:resume)
    fibers.reverse_each(&:resume)

    expect([transport.payload(0)["visitor_id"], transport.payload(1)["visitor_id"]]).to eq(%w[fiber-b fiber-a])
  end

  it "never leaks visitors across sequential worker requests" do
    transport = FakeTransport.new
    client = CekatEventSdk::Client.new(access_token: "token", transport: transport)
    expected = []
    60.times do |index|
      visitor = ("visitor-#{index}" if (index % 3).zero?)
      expected << visitor
      failing = (index % 5).zero?
      app = lambda do |_env|
        client.user_login(email: "worker@example.test")
        raise "handler failed" if failing

        [200, {}, []]
      end
      begin
        described_class.new(app).call(env_for(visitor ? { "HTTP_X_CEKAT_VISITOR_ID" => visitor } : {}))
      rescue RuntimeError
        nil
      end
      expect(CekatEventSdk::VisitorContext.current_visitor_id).to be_nil
    end
    expect(60.times.map { |index| transport.payload(index)["visitor_id"] }).to eq(expected)
  end
end
