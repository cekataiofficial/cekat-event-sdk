# frozen_string_literal: true

require "net/http"
require "openssl"
require "uri"

module CekatEventSdk
  # Default Net::HTTP transport. Each attempt opens a fresh connection (so nothing is silently
  # resent on a stale keep-alive connection), never follows redirects, bounds connect, write,
  # header, and body time by the timeout, and reads at most 65,537 body bytes.
  class Transport
    # Raised when no response status was received. The message never contains request headers.
    class Failure < StandardError
      def self.from(error)
        new("#{error.class}: #{error.message}")
      end
    end

    # A received response. body holds at most 65,536 bytes; body_read_failure is set when
    # the status arrived but the body could not be read.
    Response = Data.define(:status, :reason, :headers, :body, :body_truncated, :observed_body_bytes, :body_read_failure) do
      def header(name)
        headers.each { |key, values| return values.first if key.casecmp?(name) }
        nil
      end
    end

    class BodyDeadlineExceeded < StandardError; end
    private_constant :BodyDeadlineExceeded

    def post(uri:, headers:, body:, timeout:)
      uri = URI(uri)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = timeout
      http.read_timeout = timeout
      http.write_timeout = timeout
      http.ssl_timeout = timeout if http.use_ssl?
      http.max_retries = 0
      # Net::HTTP defaults to treating a connection closed before Content-Length as a complete
      # body; a truncated response must be reported as a body read failure instead.
      http.ignore_eof = false

      request = Net::HTTP::Post.new(uri.request_uri, headers)
      request.body = body
      deadline = monotonic + timeout
      state = { head: nil, buffer: +"", failure: nil }

      catch(:body_limit) do
        http.start do |connection|
          connection.request(request) do |response|
            state[:head] = response
            response.read_body do |chunk|
              room = MAXIMUM_RESPONSE_BODY_BYTES + 1 - state[:buffer].bytesize
              state[:buffer] << chunk.byteslice(0, room) if room.positive?
              throw :body_limit if state[:buffer].bytesize > MAXIMUM_RESPONSE_BODY_BYTES
              raise BodyDeadlineExceeded, "response body exceeded the #{timeout}s timeout" if monotonic > deadline
            end
          end
        end
      end
      response_from(state)
    rescue StandardError => e
      raise Failure.from(e) if state.nil? || state[:head].nil?

      state[:failure] = Failure.from(e)
      response_from(state)
    end

    private

    def response_from(state)
      head = state[:head]
      buffer = state[:buffer]
      Response.new(
        status: head.code.to_i,
        reason: head.message.to_s,
        headers: head.to_hash,
        body: buffer.byteslice(0, MAXIMUM_RESPONSE_BODY_BYTES).force_encoding(Encoding::UTF_8),
        body_truncated: buffer.bytesize > MAXIMUM_RESPONSE_BODY_BYTES,
        observed_body_bytes: buffer.bytesize,
        body_read_failure: buffer.bytesize > MAXIMUM_RESPONSE_BODY_BYTES ? nil : state[:failure]
      )
    end

    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
end
