<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Exception;

/**
 * Cekat returned HTTP 200 but the body was not a valid success envelope, exceeded 65,536
 * bytes, or could not be read. The event was received; it is never retried.
 */
final class ResponseDecodeException extends CekatException
{
    public readonly int $statusCode;
    public readonly bool $deliveryOutcomeUnknown;

    public function __construct(string $message, public readonly string $rawBody, public readonly int $attempts, ?\Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
        $this->statusCode = 200;
        $this->deliveryOutcomeUnknown = false;
    }
}
