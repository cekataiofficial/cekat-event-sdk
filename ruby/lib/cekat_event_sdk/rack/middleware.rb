# frozen_string_literal: true

module CekatEventSdk
  module Rack
    # Rack middleware (Sinatra, Hanami, Roda, and other Rack apps) that scopes the request's
    # visitor ID while the downstream app runs. It exposes the value as
    # env["cekat_event_sdk.visitor_id"] and never changes headers, cookies, or the response.
    #
    # The scope ends when call returns, so events emitted while a streaming body is iterated
    # must pass visitor_id explicitly.
    class Middleware
      ENV_KEY = "cekat_event_sdk.visitor_id"

      def initialize(app, visitor_context: VisitorContext)
        @app = app
        @visitor_context = visitor_context
      end

      def call(env)
        had_previous = env.key?(ENV_KEY)
        previous = env[ENV_KEY]
        visitor_id = VisitorIdResolver.from_rack_env(env)
        visitor_id ? env[ENV_KEY] = visitor_id : env.delete(ENV_KEY)
        begin
          @visitor_context.with(visitor_id) { @app.call(env) }
        ensure
          had_previous ? env[ENV_KEY] = previous : env.delete(ENV_KEY)
        end
      end
    end
  end
end
