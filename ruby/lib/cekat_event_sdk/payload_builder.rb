# frozen_string_literal: true

require "json"
require "securerandom"

module CekatEventSdk
  # Validates event input and builds the JSON request body.
  # @api private
  class PayloadBuilder
    MAX_SAFE_INTEGER = 9_007_199_254_740_991
    MAX_DEPTH = 256
    STRING_FIELDS = %i[email phone_number contact_name visitor_id event_id].freeze

    def initialize(clock: -> { Time.now }, id_generator: -> { SecureRandom.uuid })
      @clock = clock
      @id_generator = id_generator
    end

    # Returns a copy of event whose properties include the required order_paid arguments.
    def self.with_order_paid_properties(amount, currency, event)
      raise ValidationError, "amount must be a finite number" unless amount.is_a?(Numeric) && amount.real? && (amount.is_a?(Integer) || amount.to_f.finite?)
      raise ValidationError, "currency must not be blank" unless currency.is_a?(String) && !currency.strip.empty?
      return event unless event.is_a?(EventInput) && (event.properties.nil? || event.properties.is_a?(Hash))

      properties = event.properties || {}
      %w[amount currency].each do |reserved|
        if properties.key?(reserved) || properties.key?(reserved.to_sym)
          raise ValidationError, "properties must not contain #{reserved.inspect}; pass it as the order_paid argument"
        end
      end
      event.with(properties: properties.merge("amount" => amount, "currency" => currency))
    end

    def build(event_key, is_common, event, ambient_visitor_id)
      raise ValidationError, "event key must not be blank" unless event_key.is_a?(String) && !event_key.strip.empty?
      raise ValidationError, "event must be a CekatEventSdk::EventInput" unless event.is_a?(EventInput)

      STRING_FIELDS.each do |field|
        value = event.public_send(field)
        raise ValidationError, "#{field} must be a String" unless value.nil? || value.is_a?(String)
      end
      raise ValidationError, "event must include a nonblank email or phone number" if blank?(event.email) && blank?(event.phone_number)

      payload = {
        "event_key" => utf8(event_key, "event_key"),
        "event_id" => VisitorIdResolver.normalize(event.event_id) || @id_generator.call,
        "occurred_at" => occurred_at(event.occurred_at),
        "is_common" => is_common
      }
      payload["email"] = utf8(event.email, "email") unless event.email.nil?
      payload["phone_number"] = utf8(event.phone_number, "phone_number") unless event.phone_number.nil?
      payload["contact_name"] = utf8(event.contact_name, "contact_name") unless event.contact_name.nil?
      visitor_id = VisitorIdResolver.normalize(event.visitor_id) || VisitorIdResolver.normalize(ambient_visitor_id)
      payload["visitor_id"] = utf8(visitor_id, "visitor_id") if visitor_id
      unless event.properties.nil?
        raise ValidationError, "properties must be a Hash" unless event.properties.is_a?(Hash)

        payload["properties"] = normalize(event.properties, "properties", {}.compare_by_identity, 0)
      end

      JSON.generate(payload)
    rescue JSON::GeneratorError
      raise ValidationError, "event is not JSON-compatible"
    end

    private

    def blank?(value)
      value.nil? || value.strip.empty?
    end

    def occurred_at(value)
      time = value.nil? ? @clock.call : value
      raise ValidationError, "occurred_at must be a Time or DateTime" unless time.is_a?(Time) || (defined?(::DateTime) && time.is_a?(::DateTime))

      utc = time.is_a?(Time) ? time.getutc : time.to_time.utc
      raise ValidationError, "occurred_at must be between years 0001 and 9999" unless (1..9999).cover?(utc.year)

      utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
    end

    def utf8(value, path)
      string = value.encoding == Encoding::UTF_8 ? value : value.dup.force_encoding(Encoding::UTF_8)
      raise ValidationError, "#{path} must be valid UTF-8" unless string.valid_encoding?

      string
    end

    def normalize(value, path, ancestors, depth)
      raise ValidationError, "#{path} is nested too deeply" if depth > MAX_DEPTH

      case value
      when nil, true, false then value
      when String then utf8(value, path)
      when Symbol then utf8(value.to_s, path)
      when Integer
        raise invalid(path) unless value.between?(-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)

        value
      when Float then portable_float(value, path)
      when Numeric
        raise invalid(path) unless value.real?

        portable_float(value.to_f, path)
      when Array
        within(value, path, ancestors) do
          value.each_with_index.map { |item, index| normalize(item, "#{path}[#{index}]", ancestors, depth + 1) }
        end
      when Hash
        within(value, path, ancestors) do
          value.each_with_object({}) do |(key, item), object|
            raise ValidationError, "#{path} has a #{key.class} key; property keys must be Strings or Symbols" unless key.is_a?(String) || key.is_a?(Symbol)

            name = utf8(key.to_s, path)
            raise ValidationError, "#{path} has duplicate key #{name.inspect}" if object.key?(name)

            object[name] = normalize(item, name.empty? ? "#{path}[\"\"]" : "#{path}.#{name}", ancestors, depth + 1)
          end
        end
      else
        raise invalid(path)
      end
    end

    def portable_float(value, path)
      raise invalid(path) unless value.finite?
      raise invalid(path) if value == value.truncate && value.abs > MAX_SAFE_INTEGER

      value
    end

    def within(container, path, ancestors)
      raise ValidationError, "#{path} contains a cycle" if ancestors.key?(container)

      # Only containers on the current path are tracked, so repeated references are allowed.
      ancestors[container] = true
      result = yield
      ancestors.delete(container)
      result
    end

    def invalid(path)
      ValidationError.new("#{path} is not a JSON-compatible value")
    end
  end
end
