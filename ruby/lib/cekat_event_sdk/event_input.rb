# frozen_string_literal: true

module CekatEventSdk
  # An identity-bearing event. At least one of email or phone_number must be nonblank.
  #
  # properties is nil (omitted) or a Hash with String or Symbol keys. Values may be nil, true,
  # false, Strings, Symbols, finite numbers (Integer, Float, BigDecimal, Rational), Arrays, and
  # Hashes of those. event_id deduplicates retried deliveries and defaults to a random UUID;
  # occurred_at (a Time or DateTime) defaults to the time of the call.
  EventInput = Data.define(:email, :phone_number, :contact_name, :visitor_id, :properties, :event_id, :occurred_at) do
    def initialize(email: nil, phone_number: nil, contact_name: nil, visitor_id: nil, properties: nil, event_id: nil, occurred_at: nil)
      super
    end
  end
end
