# frozen_string_literal: true

require "spec_helper"

RSpec.describe CekatEventSdk::Transport do
  subject(:transport) { described_class.new }

  def post(server, timeout: 2)
    transport.post(uri: "#{server.origin}/api/events/ingest", headers: { "Content-Type" => "application/json" }, body: "{}", timeout: timeout)
  end

  it "returns status, reason phrase, headers, and body" do
    RawHttpServer.open([{ raw: "HTTP/1.1 418 Custom Teapot\r\nRetry-After: 1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello" }]) do |server|
      response = post(server)
      expect(response).to have_attributes(status: 418, reason: "Custom Teapot", body: "hello", body_truncated: false, body_read_failure: nil)
      expect(response.header("RETRY-AFTER")).to eq("1")
    end
  end

  it "does not follow redirects" do
    RawHttpServer.open([{ raw: "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" }]) do |server|
      expect(post(server).status).to eq(302)
    end
  end

  it "retains a bounded prefix of an oversized body" do
    body = "#{'€' * 21_846}END"
    RawHttpServer.open([{ raw: "HTTP/1.1 200 OK\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\n\r\n#{body}" }]) do |server|
      response = post(server)
      expect(response).to have_attributes(body_truncated: true, observed_body_bytes: 65_537, body_read_failure: nil)
      expect(response.body.bytesize).to eq(65_536)
      expect(response.body.b).to eq(body.b.byteslice(0, 65_536))
    end
  end

  it "reports a body read failure after headers" do
    RawHttpServer.open([{ raw: "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{\"success\":tr" }]) do |server|
      response = post(server)
      expect(response).to have_attributes(status: 200, body: '{"success":tr')
      expect(response.body_read_failure).to be_a(CekatEventSdk::Transport::Failure)
    end
  end

  it "raises a transport failure for header timeouts and refused connections" do
    RawHttpServer.open([{ raw: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", delay: 1 }]) do |server|
      expect { post(server, timeout: 0.2) }.to raise_error(CekatEventSdk::Transport::Failure, /Timeout/)
    end
    expect do
      transport.post(uri: "http://127.0.0.1:1/api/events/ingest", headers: {}, body: "{}", timeout: 0.5)
    end.to raise_error(CekatEventSdk::Transport::Failure, /ECONNREFUSED|Errno/)
  end
end
