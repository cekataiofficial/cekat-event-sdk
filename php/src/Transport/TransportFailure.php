<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Transport;

/**
 * No response status was received. The message is safe to log: it never contains request
 * headers, and the original client exception (which holds the request) is not retained.
 */
final class TransportFailure extends \RuntimeException
{
    public static function from(\Throwable $cause): self
    {
        return new self(sprintf('%s: %s', $cause::class, $cause->getMessage()));
    }
}
