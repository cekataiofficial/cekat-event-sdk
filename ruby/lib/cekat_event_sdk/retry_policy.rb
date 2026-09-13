# frozen_string_literal: true

require "time"

module CekatEventSdk
  # @api private
  module RetryPolicy
    MAXIMUM_RETRY_AFTER_MS = 5_000
    RETRYABLE_STATUSES = [429, 500, 502, 503, 504].freeze
    HTTP_DATE = /\A(?:
      [A-Za-z]{3},\ \d{2}\ [A-Za-z]{3}\ \d{4}\ \d{2}:\d{2}:\d{2}\ GMT |   # IMF-fixdate
      [A-Za-z]{6,9},\ \d{2}-[A-Za-z]{3}-\d{2}\ \d{2}:\d{2}:\d{2}\ GMT |  # RFC 850
      [A-Za-z]{3}\ [A-Za-z]{3}\ [\ \d]\d\ \d{2}:\d{2}:\d{2}\ \d{4}       # asctime
    )\z/x

    module_function

    def retryable_status?(status)
      RETRYABLE_STATUSES.include?(status)
    end

    # Full-jitter upper bound before one-indexed retry: 100ms doubling to a 1s cap.
    def delay_bound_ms(retry_number)
      [100 * (2**(retry_number.clamp(1, 5) - 1)), 1_000].min
    end

    # Parses Retry-After delta-seconds or an HTTP-date; nil when absent or invalid.
    def parse_retry_after_ms(value, now_ms)
      trimmed = value.to_s.strip
      return nil if trimmed.empty?
      return trimmed.length > 9 ? Float::INFINITY : Integer(trimmed, 10) * 1_000 if trimmed.match?(/\A\d+\z/)
      return nil unless trimmed.match?(HTTP_DATE)

      [(Time.parse("#{trimmed} UTC").to_r * 1_000).to_i - now_ms, 0].max
    rescue ArgumentError
      nil
    end
  end
end
