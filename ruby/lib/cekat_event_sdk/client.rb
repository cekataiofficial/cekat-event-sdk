# frozen_string_literal: true

require "uri"

module CekatEventSdk
  # Submits Cekat events synchronously. Construct one client and reuse it; it is thread-safe.
  #
  # Each method returns an Acknowledgement (accepted for asynchronous processing) or raises:
  # ValidationError before any request; AuthenticationError (401), EventDefinitionNotFoundError
  # (404), or ApiError for other non-200 responses; ResponseDecodeError for an invalid or
  # unreadable 200; TransportError when no response was received. Retries can create duplicate
  # events; every retry reuses the call's event_id.
  class Client
    attr_reader :base_url, :timeout, :retry_count

    # sleeper, random, and payload_builder are test seams.
    def initialize(access_token:, base_url: DEFAULT_BASE_URL, timeout: 3, retry_count: 2, transport: Transport.new,
                   visitor_context: VisitorContext, sleeper: ->(seconds) { sleep(seconds) }, random: Random.new,
                   payload_builder: PayloadBuilder.new)
      raise ValidationError, "access token must not be blank" unless access_token.is_a?(String) && !access_token.strip.empty?
      unless timeout.is_a?(Numeric) && timeout.real? && timeout.to_f.finite? && timeout.positive?
        raise ValidationError, "timeout must be a finite number of seconds greater than zero"
      end
      raise ValidationError, "retry count must be a nonnegative Integer" unless retry_count.is_a?(Integer) && !retry_count.negative?

      @access_token = access_token
      @base_url = normalize_origin(base_url)
      @timeout = timeout
      @retry_count = retry_count
      @transport = transport
      @visitor_context = visitor_context
      @sleeper = sleeper
      @random = random
      @payload_builder = payload_builder
    end

    # Each event method accepts an EventInput, a Hash, or keyword attributes:
    #   client.user_login(email: "person@example.com", properties: { plan: "pro" })
    def user_registration(event = nil, **attributes)
      track("user_registration", true, event_from(event, attributes))
    end

    def user_login(event = nil, **attributes)
      track("user_login", true, event_from(event, attributes))
    end

    def order_created(event = nil, **attributes)
      track("order_created", true, event_from(event, attributes))
    end

    def form_submitted(event = nil, **attributes)
      track("form_submitted", true, event_from(event, attributes))
    end

    # The required finite amount and nonblank currency are sent as the "amount" and "currency"
    # properties; the event's properties must not already contain either key.
    def order_paid(event = nil, amount:, currency:, **attributes)
      track("order_paid", true, PayloadBuilder.with_order_paid_properties(amount, currency, event_from(event, attributes)))
    end

    def custom_event(event_key, event = nil, **attributes)
      track(event_key, false, event_from(event, attributes))
    end

    # Runs the block with visitor_id as the current visitor (see VisitorContext.with).
    def with_visitor_id(visitor_id, &)
      VisitorContext.with(visitor_id, &)
    end

    def inspect
      "#<#{self.class.name} base_url=#{@base_url.inspect} timeout=#{@timeout} retry_count=#{@retry_count}>"
    end
    alias to_s inspect

    private

    def event_from(event, attributes)
      raise ValidationError, "pass an event or keyword attributes, not both" if event && !attributes.empty?

      case event
      when EventInput then event
      when nil then EventInput.new(**attributes)
      when Hash then EventInput.new(**event.transform_keys(&:to_sym))
      else raise ValidationError, "event must be a CekatEventSdk::EventInput or Hash"
      end
    rescue ArgumentError => e
      raise ValidationError, "invalid event attributes: #{e.message}"
    end

    def track(event_key, is_common, event)
      # Encoded once so every retry sends the same event ID and timestamp.
      body = @payload_builder.build(event_key, is_common, event, @visitor_context.current_visitor_id)
      headers = {
        "Authorization" => "Bearer #{@access_token}",
        "Content-Type" => "application/json",
        "User-Agent" => "cekat-event-sdk-ruby/#{VERSION} ruby/#{RUBY_VERSION}"
      }
      deliver("#{@base_url}#{INGEST_PATH}", headers, body)
    end

    def deliver(url, headers, body)
      maximum_attempts = @retry_count + 1
      attempt = 0
      loop do
        attempt += 1
        begin
          response = @transport.post(uri: url, headers: headers, body: body, timeout: @timeout)
        rescue Transport::Failure
          raise TransportError.new("Cekat API request failed before a response was received", attempts: attempt) if attempt >= maximum_attempts

          backoff(attempt, nil)
          next
        end

        # Retry is decided by status alone, even when the body read failed.
        if attempt < maximum_attempts && RetryPolicy.retryable_status?(response.status)
          retry_after = RetryPolicy.parse_retry_after_ms(response.header("Retry-After"), (Time.now.to_r * 1_000).to_i)
          if retry_after.nil? || retry_after <= RetryPolicy::MAXIMUM_RETRY_AFTER_MS
            backoff(attempt, retry_after)
            next
          end
          # The server asked for a longer pause than a caller should wait: report it now.
        end

        return ResponseDecoder.decode(response, attempt)
      end
    end

    def backoff(retry_number, retry_after_ms)
      jitter = @random.rand(RetryPolicy.delay_bound_ms(retry_number) + 1)
      @sleeper.call([jitter, retry_after_ms || 0].max / 1000.0)
    end

    def normalize_origin(base_url)
      invalid = ValidationError.new("base URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment")
      raise invalid unless base_url.is_a?(String) && !base_url.match?(/[\s?#]/)

      uri = URI.parse(base_url)
      unless %w[http https].include?(uri.scheme&.downcase) && uri.host && !uri.host.empty? && uri.userinfo.nil? &&
             ["", "/"].include?(uri.path)
        raise invalid
      end

      default_port = uri.scheme.casecmp?("https") ? 443 : 80
      "#{uri.scheme.downcase}://#{uri.host.downcase}#{":#{uri.port}" if uri.port != default_port}"
    rescue URI::InvalidURIError
      raise invalid
    end
  end
end
