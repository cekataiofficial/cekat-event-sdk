# frozen_string_literal: true

require "socket"

# Serves scripted raw HTTP/1.1 responses, one per connection, from a background thread.
class RawHttpServer
  attr_reader :origin

  def self.open(responses)
    server = new(responses)
    yield server
  ensure
    server&.close
  end

  def initialize(responses)
    @server = TCPServer.new("127.0.0.1", 0)
    @origin = "http://127.0.0.1:#{@server.addr[1]}"
    @thread = Thread.new do
      responses.each do |response|
        client = @server.accept
        request = +""
        request << client.readpartial(4096) until request.include?("\r\n\r\n")
        length = request[/content-length:\s*(\d+)/i, 1].to_i
        body_received = request.split("\r\n\r\n", 2)[1].to_s.bytesize
        client.read(length - body_received) if length > body_received
        sleep(response[:delay]) if response[:delay]
        client.write(response.fetch(:raw))
        client.close
      rescue IOError, SystemCallError
        nil
      end
    end
  end

  def close
    @thread.kill
    @server.close
  end
end
