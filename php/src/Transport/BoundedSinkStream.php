<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Transport;

use Psr\Http\Message\StreamInterface;

/**
 * A write-only PSR-7 sink for Guzzle that keeps a bounded body prefix. Once the sentinel byte
 * is observed, writes report zero bytes so the HTTP handler stops downloading.
 *
 * @internal
 */
final class BoundedSinkStream implements StreamInterface
{
    public function __construct(private readonly BoundedBodyBuffer $buffer) {}

    public function write(string $string): int
    {
        if ($this->buffer->isOverflowed()) {
            return 0;
        }
        $this->buffer->append($string);

        return strlen($string);
    }

    public function __toString(): string
    {
        return $this->buffer->retained();
    }

    public function getContents(): string
    {
        return $this->buffer->retained();
    }

    public function close(): void {}

    public function detach()
    {
        return null;
    }

    public function getSize(): ?int
    {
        return null;
    }

    public function tell(): int
    {
        return $this->buffer->observedBytes();
    }

    public function eof(): bool
    {
        return true;
    }

    public function isSeekable(): bool
    {
        return false;
    }

    public function seek(int $offset, int $whence = SEEK_SET): void
    {
        throw new \RuntimeException('bounded sink is not seekable');
    }

    public function rewind(): void
    {
        throw new \RuntimeException('bounded sink is not seekable');
    }

    public function isWritable(): bool
    {
        return true;
    }

    public function isReadable(): bool
    {
        return false;
    }

    public function read(int $length): string
    {
        throw new \RuntimeException('bounded sink is not readable');
    }

    public function getMetadata(?string $key = null)
    {
        return $key === null ? [] : null;
    }
}
