# frozen_string_literal: true

require "json"

module CekatEventSdk
  # Maps a received response to an Acknowledgement or a typed error.
  # @api private
  module ResponseDecoder
    STATUS_TEXT = {
      400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found",
      405 => "Method Not Allowed", 408 => "Request Timeout", 409 => "Conflict", 413 => "Content Too Large",
      415 => "Unsupported Media Type", 418 => "I'm a teapot", 422 => "Unprocessable Content", 429 => "Too Many Requests",
      500 => "Internal Server Error", 501 => "Not Implemented", 502 => "Bad Gateway",
      503 => "Service Unavailable", 504 => "Gateway Timeout"
    }.freeze

    module_function

    def decode(response, attempts)
      return acknowledgement(response, attempts) if response.status == 200

      message, code = error_envelope(response.body) || [fallback_message(response), nil]
      error_class = { 401 => AuthenticationError, 404 => EventDefinitionNotFoundError }.fetch(response.status, ApiError)
      raise error_class.new(message, status: response.status, code: code, raw_body: response.body, attempts: attempts)
    end

    def acknowledgement(response, attempts)
      body = response.body
      if response.body_read_failure
        raise ResponseDecodeError.new("response body could not be read", raw_body: body, attempts: attempts),
              cause: response.body_read_failure
      end
      raise ResponseDecodeError.new("response body exceeds #{MAXIMUM_RESPONSE_BODY_BYTES} bytes", raw_body: body, attempts: attempts) if response.body_truncated

      envelope = parse(body)
      data = envelope.is_a?(Hash) ? envelope["data"] : nil
      properties = data.is_a?(Hash) ? data["validated_properties"] : nil
      valid = envelope.is_a?(Hash) && envelope["success"] == true && data.is_a?(Hash) && data["success"] == true &&
              nonempty_string?(data["message"]) && nonempty_string?(data["event_key"]) &&
              properties.is_a?(Array) && properties.all?(String)
      raise ResponseDecodeError.new("response body is not a valid success envelope", raw_body: body, attempts: attempts) unless valid

      Acknowledgement.new(success: true, message: data["message"], event_key: data["event_key"],
                          validated_properties: properties.freeze, raw_body: body)
    rescue JSON::ParserError, EncodingError
      raise ResponseDecodeError.new("response body is not valid JSON", raw_body: body, attempts: attempts)
    end

    def error_envelope(body)
      envelope = parse(body)
      return nil unless envelope.is_a?(Hash) && envelope["success"] == false && nonempty_string?(envelope["error"])
      return [envelope["error"], nil] unless envelope.key?("code")

      envelope["code"].is_a?(String) ? [envelope["error"], envelope["code"]] : nil
    rescue JSON::ParserError, EncodingError
      nil
    end

    def fallback_message(response)
      reason = response.reason.to_s.strip
      reason.empty? ? STATUS_TEXT.fetch(response.status, "HTTP #{response.status}") : reason
    end

    def parse(body)
      JSON.parse(body)
    end

    def nonempty_string?(value)
      value.is_a?(String) && !value.empty?
    end
  end
end
