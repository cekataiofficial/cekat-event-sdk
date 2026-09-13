# frozen_string_literal: true

module CekatEventSdk
  # Cekat accepted the event for asynchronous processing. This does not confirm durable
  # storage, identity resolution, delivery completion, or analytics availability.
  Acknowledgement = Data.define(:success, :message, :event_key, :validated_properties, :raw_body)
end
