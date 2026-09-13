<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Unit;

use Cekat\EventSdk\Context\VisitorContext;
use GuzzleHttp\Psr7\ServerRequest;
use PHPUnit\Framework\TestCase;

final class VisitorContextTest extends TestCase
{
    public function testScopesNestAndRestoreOnReturnAndException(): void
    {
        $context = new VisitorContext();
        $observed = $context->runWithVisitorId(' outer ', static function () use ($context): array {
            $inner = $context->runWithVisitorId('inner', static fn(): ?string => $context->current());
            $blank = $context->runWithVisitorId(" \t", static fn(): ?string => $context->current());

            return [$context->current(), $inner, $blank];
        });
        self::assertSame(['outer', 'inner', null], $observed);
        self::assertNull($context->current());

        $thrown = null;
        try {
            $context->runWithVisitorId('failing', static fn(): mixed => throw new \LogicException('handler failed'));
        } catch (\LogicException $error) {
            $thrown = $error;
        }
        self::assertInstanceOf(\LogicException::class, $thrown);
        self::assertNull($context->current());
    }

    public function testReplaceReturnsPreviousForManualRestore(): void
    {
        $context = new VisitorContext();
        self::assertNull($context->replace('first'));
        self::assertSame('first', $context->replace(' second '));
        self::assertSame('second', $context->current());
        $context->restore(null);
        self::assertNull($context->current());
    }

    public function testRunWithPsrRequestAndSharedInstance(): void
    {
        $context = new VisitorContext();
        $request = (new ServerRequest('GET', '/'))->withHeader('X-Cekat-Visitor-ID', ' psr-visitor ');
        self::assertSame('psr-visitor', $context->runWithPsrRequest($request, static fn(): ?string => $context->current()));
        self::assertSame(VisitorContext::shared(), VisitorContext::shared());
    }
}
