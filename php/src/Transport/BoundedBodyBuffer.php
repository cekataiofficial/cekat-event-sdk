<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Transport;

/**
 * Accumulates at most MAX_BODY_BYTES + 1 bytes: the retained prefix plus one sentinel byte
 * that proves truncation without buffering the rest of an oversized body.
 *
 * @internal
 */
final class BoundedBodyBuffer
{
    private string $bytes = '';

    /** Appends $chunk and returns false once the sentinel byte has been observed. */
    public function append(string $chunk): bool
    {
        $room = TransportResponse::MAX_BODY_BYTES + 1 - strlen($this->bytes);
        if ($room > 0) {
            $this->bytes .= substr($chunk, 0, $room);
        }

        return !$this->isOverflowed();
    }

    public function isOverflowed(): bool
    {
        return strlen($this->bytes) > TransportResponse::MAX_BODY_BYTES;
    }

    public function retained(): string
    {
        return substr($this->bytes, 0, TransportResponse::MAX_BODY_BYTES);
    }

    public function observedBytes(): int
    {
        return strlen($this->bytes);
    }
}
