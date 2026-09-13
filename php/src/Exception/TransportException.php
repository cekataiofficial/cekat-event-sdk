<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Exception;

/**
 * The request failed before a response was received, after all attempts. Cekat may still
 * have received the event, so the delivery outcome is unknown and a resend can duplicate it.
 */
final class TransportException extends CekatException
{
    public readonly bool $deliveryOutcomeUnknown;

    public function __construct(string $message, public readonly int $attempts, ?\Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
        $this->deliveryOutcomeUnknown = true;
    }
}
