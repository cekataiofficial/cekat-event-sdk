# frozen_string_literal: true

require_relative "cekat_event_sdk/version"

# Cekat event SDK: submit identity-bearing events and correlate them with the browser visitor.
module CekatEventSdk
  DEFAULT_BASE_URL = "https://server.cekat.ai"
  INGEST_PATH = "/api/events/ingest"
  VISITOR_HEADER = "X-Cekat-Visitor-ID"
  VISITOR_COOKIE = "_cekat_visitor_id"
  MAXIMUM_RESPONSE_BODY_BYTES = 65_536
end

require_relative "cekat_event_sdk/errors"
require_relative "cekat_event_sdk/event_input"
require_relative "cekat_event_sdk/acknowledgement"
require_relative "cekat_event_sdk/visitor_id_resolver"
require_relative "cekat_event_sdk/visitor_context"
require_relative "cekat_event_sdk/payload_builder"
require_relative "cekat_event_sdk/retry_policy"
require_relative "cekat_event_sdk/transport"
require_relative "cekat_event_sdk/response_decoder"
require_relative "cekat_event_sdk/client"
require_relative "cekat_event_sdk/rack/middleware"
require_relative "cekat_event_sdk/rails" if defined?(Rails::Railtie)
