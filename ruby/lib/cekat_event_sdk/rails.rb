# frozen_string_literal: true

require "active_support"
require "active_support/current_attributes"
require "rails/railtie"

module CekatEventSdk
  # Rails integration. The Railtie inserts CekatEventSdk::Rails::Middleware, which exposes the
  # request visitor as CekatEventSdk::Rails::Current.visitor_id and scopes it for the client.
  module Rails
    # Request-scoped attributes; visitor_id is set by Middleware for each request.
    class Current < ActiveSupport::CurrentAttributes
      attribute :visitor_id
    end

    # Reads the visitor from CurrentAttributes; pass as a client's visitor_context when code
    # sets Current.visitor_id itself (for example in a job).
    module VisitorContext
      module_function

      def current_visitor_id
        Current.visitor_id || CekatEventSdk::VisitorContext.current_visitor_id
      end
    end

    # Scopes the request visitor for Current and for CekatEventSdk::VisitorContext.
    class Middleware
      def initialize(app)
        @app = app
      end

      # Current.set restores the previous attributes when the block exits, and Rails resets
      # CurrentAttributes after each request, so no state crosses requests.
      def call(env)
        visitor_id = VisitorIdResolver.from_rack_env(env)
        Current.set(visitor_id: visitor_id) do
          CekatEventSdk::VisitorContext.with(visitor_id) { @app.call(env) }
        end
      end
    end

    # Inserts Middleware unless config.cekat_event_sdk.insert_middleware is false.
    class Railtie < ::Rails::Railtie
      config.cekat_event_sdk = ActiveSupport::OrderedOptions.new
      config.cekat_event_sdk.insert_middleware = true

      initializer "cekat_event_sdk.middleware" do |app|
        app.middleware.use CekatEventSdk::Rails::Middleware if app.config.cekat_event_sdk.insert_middleware
      end
    end
  end
end
