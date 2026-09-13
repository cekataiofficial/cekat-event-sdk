# frozen_string_literal: true

require "logger"
require "rails"
require "action_controller/railtie"
require "spec_helper"
require "rack/mock"

TRANSPORT = FakeTransport.new
CLIENT = CekatEventSdk::Client.new(access_token: "rails-token", transport: TRANSPORT)

class CekatRailsTestApp < Rails::Application
  config.load_defaults Rails::VERSION::STRING.to_f
  config.root = __dir__
  config.eager_load = false
  config.logger = Logger.new(nil)
  config.secret_key_base = "x" * 64
  config.hosts.clear
end

class OrdersController < ActionController::API
  def create
    CLIENT.order_paid(email: "buyer@example.test", properties: { order_id: params[:order_id] }, amount: 125_000, currency: "IDR")
    render json: { current: CekatEventSdk::Rails::Current.visitor_id, scope: CekatEventSdk::VisitorContext.current_visitor_id }
  end

  def boom
    raise "downstream failure"
  end
end

CekatRailsTestApp.initialize!
CekatRailsTestApp.routes.draw do
  post "/orders" => "orders#create"
  get "/boom" => "orders#boom"
end

RSpec.describe CekatEventSdk::Rails::Middleware do
  let(:request) { Rack::MockRequest.new(CekatRailsTestApp) }

  it "is inserted by the Railtie" do
    expect(CekatRailsTestApp.middleware.middlewares).to include(described_class)
  end

  it "exposes the visitor through Current and the client scope for each request" do
    first = request.post("/orders", params: { order_id: "ord-1" }, "HTTP_X_CEKAT_VISITOR_ID" => " header ", "HTTP_COOKIE" => "_cekat_visitor_id=cookie")
    second = request.post("/orders", params: { order_id: "ord-2" }, "HTTP_COOKIE" => "_cekat_visitor_id=browser-cookie")
    third = request.post("/orders", params: { order_id: "ord-3" })

    expect([first, second, third].map { |response| JSON.parse(response.body) }).to eq([
                                                                                        { "current" => "header", "scope" => "header" },
                                                                                        { "current" => "browser-cookie", "scope" => "browser-cookie" },
                                                                                        { "current" => nil, "scope" => nil }
                                                                                      ])
    payloads = TRANSPORT.requests.last(3).map { |sent| JSON.parse(sent[:body]) }
    expect(payloads.map { |payload| payload["visitor_id"] }).to eq(["header", "browser-cookie", nil])
    expect(payloads.first["properties"]).to eq("order_id" => "ord-1", "amount" => 125_000, "currency" => "IDR")
    expect(CekatEventSdk::Rails::Current.visitor_id).to be_nil
    expect(CekatEventSdk::VisitorContext.current_visitor_id).to be_nil
  end

  it "restores an outer Current scope after nested calls and exceptions" do
    middleware = described_class.new(->(_env) { raise "downstream failure" })
    CekatEventSdk::Rails::Current.set(visitor_id: "outer") do
      expect { middleware.call(Rack::MockRequest.env_for("/", "HTTP_X_CEKAT_VISITOR_ID" => "inner")) }.to raise_error("downstream failure")
      expect(CekatEventSdk::Rails::Current.visitor_id).to eq("outer")
      nested = described_class.new(->(_env) { [200, {}, [CekatEventSdk::Rails::Current.visitor_id]] })
      expect(nested.call(Rack::MockRequest.env_for("/", "HTTP_X_CEKAT_VISITOR_ID" => "nested"))[2]).to eq(["nested"])
      expect(CekatEventSdk::Rails::Current.visitor_id).to eq("outer")
    end
  end

  it "resets state after a failing request" do
    expect(request.get("/boom", "HTTP_X_CEKAT_VISITOR_ID" => "failing").status).to eq(500)
    expect(CekatEventSdk::Rails::Current.visitor_id).to be_nil
    expect(CekatEventSdk::VisitorContext.current_visitor_id).to be_nil
  end

  it "accepts ActiveSupport::TimeWithZone for occurred_at" do
    transport = FakeTransport.new
    client = CekatEventSdk::Client.new(access_token: "token", transport: transport)
    occurred_at = Time.use_zone("Asia/Jakarta") { Time.zone.local(2026, 9, 13, 8, 15, 30.25r) }
    client.user_login(email: "a@b.c", occurred_at: occurred_at)
    expect(transport.payload["occurred_at"]).to eq("2026-09-13T01:15:30.250Z")
  end

  it "provides a CurrentAttributes-backed visitor context for code that sets Current itself" do
    transport = FakeTransport.new
    client = CekatEventSdk::Client.new(access_token: "token", transport: transport, visitor_context: CekatEventSdk::Rails::VisitorContext)
    CekatEventSdk::Rails::Current.set(visitor_id: "from-job") { client.user_login(email: "a@b.c") }
    expect(transport.payload["visitor_id"]).to eq("from-job")
  end
end
