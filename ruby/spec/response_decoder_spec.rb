# frozen_string_literal: true

require "spec_helper"

RSpec.describe CekatEventSdk::ResponseDecoder do
  success = '{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"],"extra":1}}'

  def decode(response)
    described_class.decode(response, 2)
  end

  it "decodes the strict success envelope" do
    ack = decode(FakeTransport.response(200, success))
    expect(ack).to have_attributes(success: true, message: "accepted", event_key: "order_paid", validated_properties: ["order_id"], raw_body: success)
  end

  [
    "{not-json",
    '{"success":false,"data":{"success":true,"message":"a","event_key":"k","validated_properties":[]}}',
    '{"success":true,"data":[]}',
    '{"success":true,"data":{"message":"a","event_key":"k","validated_properties":[]}}',
    '{"success":true,"data":{"success":true,"message":"","event_key":"k","validated_properties":[]}}',
    '{"success":true,"data":{"success":true,"message":"a","event_key":"","validated_properties":[]}}',
    '{"success":true,"data":{"success":true,"message":"a","event_key":"k","validated_properties":{}}}',
    '{"success":true,"data":{"success":true,"message":"a","event_key":"k","validated_properties":[1]}}'
  ].each do |body|
    it "treats #{body} as a decode error" do
      expect { decode(FakeTransport.response(200, body)) }.to raise_error(CekatEventSdk::ResponseDecodeError) { |error|
        expect(error).to have_attributes(raw_body: body, status: 200, attempts: 2, delivery_outcome_unknown?: false)
      }
    end
  end

  it "reports truncated and unreadable success bodies as decode errors" do
    expect { decode(FakeTransport.response(200, "a" * 65_536, truncated: true)) }
      .to raise_error(CekatEventSdk::ResponseDecodeError, /exceeds 65536 bytes/)
    failure = CekatEventSdk::Transport::Failure.new("EOFError: end of file reached")
    expect { decode(FakeTransport.response(200, '{"success":tr', failure: failure)) }
      .to raise_error(CekatEventSdk::ResponseDecodeError, /could not be read/) { |error| expect(error.cause).to eq(failure) }
  end

  it "maps structured errors to typed exceptions" do
    body = '{"success":false,"error":"defined server error","code":"fixture_code"}'
    { 400 => CekatEventSdk::ApiError, 401 => CekatEventSdk::AuthenticationError,
      404 => CekatEventSdk::EventDefinitionNotFoundError, 422 => CekatEventSdk::ApiError }.each do |status, klass|
      expect { decode(FakeTransport.response(status, body, reason: "Fallback")) }.to raise_error(klass) { |error|
        expect(error.class).to eq(klass)
        expect(error).to have_attributes(message: "defined server error", code: "fixture_code", status: status, raw_body: body,
                                         attempts: 2, delivery_outcome_unknown?: false)
      }
    end
  end

  it "uses the reason phrase, then status text, for malformed error bodies" do
    {
      FakeTransport.response(418, "not json", reason: " Custom Reason ") => "Custom Reason",
      FakeTransport.response(418, '{"success":false,"error":""}') => "I'm a teapot",
      FakeTransport.response(504, '{"success":false,"error":"x","code":null}') => "Gateway Timeout",
      FakeTransport.response(599, "") => "HTTP 599"
    }.each do |response, message|
      expect { decode(response) }.to raise_error(CekatEventSdk::ApiError) { |error|
        expect(error.message).to eq(message)
        expect(error.code).to be_nil
      }
    end
  end
end
