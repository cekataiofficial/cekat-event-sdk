<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Transport;

use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * Bridges any PSR-18 client. PSR-18 has no portable per-request timeout: the SDK timeout is
 * NOT enforced, so configure the timeout (and disable redirects) on the client you inject.
 */
final class Psr18Transport implements Transport
{
    public function __construct(
        private readonly ClientInterface $client,
        private readonly RequestFactoryInterface $requests,
        private readonly StreamFactoryInterface $streams,
    ) {}

    public function send(TransportRequest $request, float $timeoutSeconds): TransportResponse
    {
        $psrRequest = $this->requests->createRequest($request->method, $request->url)
            ->withBody($this->streams->createStream($request->body));
        foreach ($request->headers as $name => $value) {
            $psrRequest = $psrRequest->withHeader($name, $value);
        }

        try {
            $response = $this->client->sendRequest($psrRequest);
        } catch (ClientExceptionInterface $error) {
            throw TransportFailure::from($error);
        }

        $buffer = new BoundedBodyBuffer();
        $failure = null;
        try {
            $body = $response->getBody();
            while (!$body->eof()) {
                $chunk = $body->read(8192);
                // Stop on an empty read or as soon as the sentinel byte proves truncation.
                if ($chunk === '' || !$buffer->append($chunk)) {
                    break;
                }
            }
        } catch (\Throwable $error) {
            $failure = TransportFailure::from($error);
        }

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
