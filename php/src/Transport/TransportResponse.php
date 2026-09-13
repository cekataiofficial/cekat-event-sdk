<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Transport;

final readonly class TransportResponse
{
    public const MAX_BODY_BYTES = 65_536;

    /**
     * @param array<string, list<string>> $headers
     * @param string $body At most MAX_BODY_BYTES retained bytes.
     * @param bool $bodyTruncated Whether the server sent more than MAX_BODY_BYTES bytes.
     * @param int $observedBodyBytes Bytes examined: retained bytes plus at most one sentinel byte.
     * @param \Throwable|null $bodyReadFailure Set when headers arrived but the body read failed.
     */
    public function __construct(
        public int $status,
        public array $headers,
        public string $body,
        public string $reasonPhrase,
        public bool $bodyTruncated = false,
        public int $observedBodyBytes = 0,
        public ?\Throwable $bodyReadFailure = null,
    ) {}

    public function header(string $name): ?string
    {
        foreach ($this->headers as $headerName => $values) {
            if (strcasecmp((string) $headerName, $name) === 0 && $values !== []) {
                return $values[0];
            }
        }

        return null;
    }
}
