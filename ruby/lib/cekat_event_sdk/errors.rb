# frozen_string_literal: true

module CekatEventSdk
  # Base class for every error raised by the SDK.
  class Error < StandardError
    # Number of HTTP attempts made; zero when nothing was sent.
    attr_reader :attempts

    def initialize(message = nil, attempts: 0)
      super(message)
      @attempts = attempts
    end

    # Whether Cekat may have received the event even though no response was seen.
    def delivery_outcome_unknown?
      false
    end
  end

  # Invalid configuration or event input, detected before any request.
  class ValidationError < Error; end

  # Cekat returned a non-200 response. The delivery outcome is known.
  class ApiError < Error
    attr_reader :status, :code, :raw_body

    # raw_body holds at most the first 65,536 response bytes.
    def initialize(message, status:, code:, raw_body:, attempts:)
      super(message, attempts: attempts)
      @status = status
      @code = code
      @raw_body = raw_body
    end
  end

  # HTTP 401: Cekat rejected the access token.
  class AuthenticationError < ApiError; end

  # HTTP 404: the tenant has no definition for the event key.
  class EventDefinitionNotFoundError < ApiError; end

  # No response was received after all attempts. Cekat may have received the event,
  # so resending it can create a duplicate.
  class TransportError < Error
    def delivery_outcome_unknown?
      true
    end
  end

  # HTTP 200 whose body was invalid, over 65,536 bytes, or unreadable. The event was received.
  class ResponseDecodeError < Error
    attr_reader :raw_body

    def initialize(message, raw_body:, attempts:)
      super(message, attempts: attempts)
      @raw_body = raw_body
    end

    def status
      200
    end
  end
end
