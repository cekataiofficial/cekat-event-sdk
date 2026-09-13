<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Transport;

use Cekat\EventSdk\Tests\Support\RawHttpServer;
use Cekat\EventSdk\Transport\GuzzleTransport;
use Cekat\EventSdk\Transport\TransportFailure;
use Cekat\EventSdk\Transport\TransportRequest;
use PHPUnit\Framework\TestCase;

final class GuzzleTransportTest extends TestCase
{
    private ?RawHttpServer $server = null;

    protected function tearDown(): void
    {
        $this->server?->stop();
    }

    private function send(string $raw, float $timeout = 2.0, int $delayMs = 0): \Cekat\EventSdk\Transport\TransportResponse
    {
        $this->server = RawHttpServer::start([['raw' => $raw, 'delay_ms' => $delayMs]]);

        return (new GuzzleTransport())->send(new TransportRequest('POST', $this->server->origin . '/api/events/ingest', ['Content-Type' => 'application/json'], '{}'), $timeout);
    }

    public function testReturnsStatusHeadersReasonPhraseAndBody(): void
    {
        $response = $this->send("HTTP/1.1 418 Custom Teapot\r\nRetry-After: 1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
        self::assertSame(418, $response->status);
        self::assertSame('Custom Teapot', $response->reasonPhrase);
        self::assertSame('1', $response->header('retry-after'));
        self::assertSame('hello', $response->body);
        self::assertFalse($response->bodyTruncated);
        self::assertNull($response->bodyReadFailure);
    }

    public function testDoesNotFollowRedirects(): void
    {
        $response = $this->send("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        self::assertSame(302, $response->status);
    }

    public function testRetainsBoundedPrefixOfOversizedBody(): void
    {
        $body = str_repeat('€', 21846) . 'END';
        $response = $this->send("HTTP/1.1 200 OK\r\nContent-Length: " . strlen($body) . "\r\nConnection: close\r\n\r\n" . $body);
        self::assertTrue($response->bodyTruncated);
        self::assertSame(65536, strlen($response->body));
        self::assertSame(substr($body, 0, 65536), $response->body);
        self::assertSame(65537, $response->observedBodyBytes);
        self::assertNull($response->bodyReadFailure);
    }

    public function testReportsBodyReadFailureAfterHeaders(): void
    {
        $response = $this->send("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{\"success\":tr");
        self::assertSame(200, $response->status);
        self::assertSame('{"success":tr', $response->body);
        self::assertInstanceOf(TransportFailure::class, $response->bodyReadFailure);
    }

    public function testTimeoutBeforeHeadersAndRefusedConnectionAreTransportFailures(): void
    {
        try {
            $this->send("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", 0.2, 1000);
            self::fail('Expected TransportFailure');
        } catch (TransportFailure $failure) {
            self::assertMatchesRegularExpression('/cURL error 28|timed out/i', $failure->getMessage());
            self::assertNull($failure->getPrevious());
        }

        $this->expectException(TransportFailure::class);
        (new GuzzleTransport())->send(new TransportRequest('POST', 'http://127.0.0.1:1/api/events/ingest', [], '{}'), 0.5);
    }
}
