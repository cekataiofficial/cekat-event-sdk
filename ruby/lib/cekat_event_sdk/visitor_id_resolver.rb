# frozen_string_literal: true

module CekatEventSdk
  # Resolves the browser visitor ID: a nonblank X-Cekat-Visitor-ID header wins over a nonblank
  # _cekat_visitor_id cookie. Values are trimmed and otherwise not decoded.
  module VisitorIdResolver
    module_function

    # Trims a visitor ID; blank or non-String values become nil.
    def normalize(visitor_id)
      return nil unless visitor_id.is_a?(String)

      trimmed = visitor_id.strip
      trimmed.empty? ? nil : trimmed
    end

    def from_header_and_cookie(header:, cookie:)
      normalize(header) || normalize(cookie)
    end

    # Returns the first nonblank _cekat_visitor_id value in a raw Cookie header.
    def from_cookie_header(cookie_header)
      return nil unless cookie_header.is_a?(String)

      cookie_header.split(";").each do |pair|
        name, separator, value = pair.partition("=")
        next if separator.empty? || name.strip != VISITOR_COOKIE

        visitor_id = normalize(value)
        return visitor_id if visitor_id
      end
      nil
    end

    # Resolves from a Rack env. The raw Cookie header is used so values are never unescaped.
    def from_rack_env(env)
      from_header_and_cookie(header: env["HTTP_X_CEKAT_VISITOR_ID"], cookie: from_cookie_header(env["HTTP_COOKIE"]))
    end
  end
end
