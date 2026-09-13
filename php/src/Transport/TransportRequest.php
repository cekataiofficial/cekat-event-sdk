<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Transport;

final readonly class TransportRequest
{
    /**
     * @param array<string, string> $headers
     */
    public function __construct(
        public string $method,
        public string $url,
        public array $headers,
        public string $body,
    ) {}
}
