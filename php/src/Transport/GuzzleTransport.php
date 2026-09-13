<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Transport;

use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\RequestOptions;
use Psr\Http\Message\ResponseInterface;

/**
 * Default transport. Enforces the per-attempt timeout (connection, headers, and body), never
 * follows redirects or retries, and reads at most 65,537 body bytes.
 *
 * Each attempt uses a fresh connection. libcurl silently resends a request when a reused
 * keep-alive connection turns out to be closed, which would hide a possible duplicate from the
 * SDK's attempt accounting; forbidding reuse keeps every send visible to the retry policy.
 */
final class GuzzleTransport implements Transport
{
    private readonly ClientInterface $client;

    public function __construct(?ClientInterface $client = null)
    {
        $this->client = $client ?? new GuzzleClient();
    }

    public function send(TransportRequest $request, float $timeoutSeconds): TransportResponse
    {
        $buffer = new BoundedBodyBuffer();
        $head = null;
        try {
            $response = $this->client->request($request->method, $request->url, [
                RequestOptions::HEADERS => $request->headers,
                RequestOptions::BODY => $request->body,
                RequestOptions::TIMEOUT => $timeoutSeconds,
                RequestOptions::CONNECT_TIMEOUT => $timeoutSeconds,
                RequestOptions::HTTP_ERRORS => false,
                RequestOptions::ALLOW_REDIRECTS => false,
                RequestOptions::SINK => new BoundedSinkStream($buffer),
                'curl' => self::curlOptions(),
                RequestOptions::ON_HEADERS => static function (ResponseInterface $received) use (&$head): void {
                    $head = $received;
                },
            ]);
        } catch (\Throwable $error) {
            if (!$head instanceof ResponseInterface) {
                throw TransportFailure::from($error);
            }

            // Headers arrived, so the status is known. Stopping at the sentinel byte is expected.
            return self::response($head, $buffer, $buffer->isOverflowed() ? null : TransportFailure::from($error));
        }

        return self::response($head instanceof ResponseInterface ? $head : $response, $buffer, null);
    }

    /** @return array<int, bool> */
    private static function curlOptions(): array
    {
        return \defined('CURLOPT_FORBID_REUSE') && \defined('CURLOPT_FRESH_CONNECT')
            ? [\CURLOPT_FORBID_REUSE => true, \CURLOPT_FRESH_CONNECT => true]
            : [];
    }

    private static function response(ResponseInterface $response, BoundedBodyBuffer $buffer, ?\Throwable $failure): TransportResponse
    {
        /** @var array<string, list<string>> $headers */
        $headers = $response->getHeaders();

        return new TransportResponse(
            $response->getStatusCode(),
            $headers,
            $buffer->retained(),
            $response->getReasonPhrase(),
            $buffer->isOverflowed(),
            $buffer->observedBytes(),
            $failure,
        );
    }
}
