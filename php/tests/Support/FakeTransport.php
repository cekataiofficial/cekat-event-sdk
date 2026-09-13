<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Support;

use Cekat\EventSdk\Transport\Transport;
use Cekat\EventSdk\Transport\TransportFailure;
use Cekat\EventSdk\Transport\TransportRequest;
use Cekat\EventSdk\Transport\TransportResponse;

final class FakeTransport implements Transport
{
    /** @var list<TransportRequest> */
    public array $requests = [];

    /** @var list<float> */
    public array $timeouts = [];

    /** @param list<TransportResponse|TransportFailure> $outcomes */
    public function __construct(private array $outcomes = []) {}

    public static function success(string $eventKey = 'order_paid'): TransportResponse
    {
        return self::response(200, json_encode([
            'success' => true,
            'data' => ['success' => true, 'message' => 'accepted', 'event_key' => $eventKey, 'validated_properties' => ['order_id']],
        ], JSON_THROW_ON_ERROR));
    }

    /** @param array<string, list<string>> $headers */
    public static function response(int $status, string $body, array $headers = [], string $reason = ''): TransportResponse
    {
        return new TransportResponse($status, $headers, $body, $reason, false, strlen($body));
    }

    public function send(TransportRequest $request, float $timeoutSeconds): TransportResponse
    {
        $this->requests[] = $request;
        $this->timeouts[] = $timeoutSeconds;
        $outcome = array_shift($this->outcomes) ?? self::success();
        if ($outcome instanceof TransportFailure) {
            throw $outcome;
        }

        return $outcome;
    }

    /** @return array<string, mixed> */
    public function payload(int $index = 0): array
    {
        /** @var array<string, mixed> $payload */
        $payload = json_decode($this->requests[$index]->body, true, 512, JSON_THROW_ON_ERROR);

        return $payload;
    }
}
