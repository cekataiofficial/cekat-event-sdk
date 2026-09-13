# frozen_string_literal: true

module CekatEventSdk
  # Request-local visitor scope stored in fiber storage (Fiber[]), so it is isolated per
  # request fiber under threaded (Puma) and fiber-based (Falcon) servers. Fibers and threads
  # created inside a scope start with a copy of it. Visitor IDs are untrusted correlation data:
  # never use them for authentication or authorization.
  module VisitorContext
    STORAGE_KEY = :cekat_event_sdk_visitor_id

    module_function

    def current_visitor_id
      Fiber[STORAGE_KEY]
    end

    # Runs the block with visitor_id (trimmed; blank means none) as the current visitor and
    # restores the previous value afterwards, including when the block raises.
    def with(visitor_id)
      previous = Fiber[STORAGE_KEY]
      Fiber[STORAGE_KEY] = VisitorIdResolver.normalize(visitor_id)
      begin
        yield
      ensure
        Fiber[STORAGE_KEY] = previous
      end
    end
  end
end
