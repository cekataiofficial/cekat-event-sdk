<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Unit;

use Cekat\EventSdk\ClientOptions;
use Cekat\EventSdk\Exception\ValidationException;
use PHPUnit\Framework\TestCase;

final class ClientOptionsTest extends TestCase
{
    public function testDefaultsAndOriginNormalization(): void
    {
        $defaults = new ClientOptions();
        self::assertSame('https://t.cekat.ai', $defaults->baseUrl);
        self::assertSame(3.0, $defaults->timeoutSeconds);
        self::assertSame(2, $defaults->retryCount);
        self::assertSame('http://127.0.0.1:8080', (new ClientOptions('HTTP://127.0.0.1:8080/'))->baseUrl);
    }

    public function testRejectsInvalidOptions(): void
    {
        foreach (['t.cekat.ai', 'ftp://t.cekat.ai', 'https://user:pass@t.cekat.ai', 'https://t.cekat.ai/events', 'https://t.cekat.ai/?q=1', 'https://t.cekat.ai/?', 'https://t.cekat.ai/#frag', 'https://'] as $baseUrl) {
            $this->assertRejected(static fn() => new ClientOptions($baseUrl), 'base URL');
        }
        $this->assertRejected(static fn() => new ClientOptions(timeoutSeconds: 0), 'timeout');
        $this->assertRejected(static fn() => new ClientOptions(timeoutSeconds: INF), 'timeout');
        $this->assertRejected(static fn() => new ClientOptions(retryCount: -1), 'retry count');
    }

    private function assertRejected(callable $callback, string $message): void
    {
        try {
            $callback();
            self::fail('Expected ValidationException');
        } catch (ValidationException $error) {
            self::assertStringContainsString($message, $error->getMessage());
        }
    }
}
