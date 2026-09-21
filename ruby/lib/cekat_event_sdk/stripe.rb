# frozen_string_literal: true

module CekatEventSdk
  # Builds Stripe metadata for optional Cekat visitor correlation.
  module Stripe
    VISITOR_METADATA_KEY = "cekat_visitor_id"

    module_function

    def metadata_for_visitor(visitor_id)
      normalized = valid_visitor_id(visitor_id)
      normalized.nil? ? {} : { VISITOR_METADATA_KEY => normalized }
    end

    def metadata_from_current_visitor
      metadata_for_visitor(VisitorContext.current_visitor_id)
    end

    def merge_metadata(metadata, visitor_id)
      merged = metadata.dup
      normalized = valid_visitor_id(visitor_id)
      merged[VISITOR_METADATA_KEY] = normalized unless normalized.nil?
      merged
    end

    def valid_visitor_id(visitor_id)
      return nil unless visitor_id.is_a?(String)

      normalized = visitor_id.strip
      return nil unless normalized.match?(/\A[A-Za-z0-9_-]{1,128}\z/)

      normalized
    end
    private_class_method :valid_visitor_id
  end
end
