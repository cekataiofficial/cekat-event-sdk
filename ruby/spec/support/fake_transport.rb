# frozen_string_literal: true

require "json"

class FakeTransport
  attr_reader :requests

  def initialize(outcomes = [])
    @outcomes = outcomes.dup
    @requests = []
  end

  def self.response(status, body = "", headers: {}, reason: "", failure: nil, truncated: false)
    CekatEventSdk::Transport::Response.new(
      status: status, reason: reason, headers: headers.transform_values { |value| Array(value) }, body: body,
      body_truncated: truncated, observed_body_bytes: body.bytesize + (truncated ? 1 : 0), body_read_failure: failure
    )
  end

  def self.success(event_key = "order_paid")
    response(200, JSON.generate(success: true,
                                data: { success: true, message: "accepted", event_key: event_key, validated_properties: ["order_id"] }))
  end

  def post(uri:, headers:, body:, timeout:)
    @requests << { uri: uri, headers: headers, body: body, timeout: timeout }
    outcome = @outcomes.shift || self.class.success
    raise outcome if outcome.is_a?(Exception)

    outcome
  end

  def payload(index = 0)
    JSON.parse(@requests.fetch(index)[:body])
  end
end
