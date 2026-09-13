<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Integration;

use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Context\VisitorContextInterface;
use Cekat\EventSdk\Integration\Psr15\VisitorMiddleware;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Psr7\ServerRequest;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

final class Psr15MiddlewareTest extends TestCase
{
    public function testScopesVisitorWithoutChangingRequestOrResponse(): void
    {
        $context = new VisitorContext();
        $middleware = new VisitorMiddleware($context);
        $request = (new ServerRequest('POST', '/orders'))
            ->withHeader('X-Cekat-Visitor-ID', ' header-visitor ')
            ->withHeader('Cookie', '_cekat_visitor_id=cookie-visitor');
        $original = new Response(201, ['X-Downstream' => 'preserved']);
        $handler = new CallbackHandler(static function (ServerRequestInterface $received) use ($context, $request, $original): ResponseInterface {
            self::assertSame($request, $received);
            self::assertSame('header-visitor', $context->current());

            return $original;
        });

        self::assertSame($original, $middleware->process($request, $handler));
        self::assertNull($context->current());
    }

    public function testRestoresOuterScopeAfterException(): void
    {
        $context = new VisitorContext();
        $middleware = new VisitorMiddleware($context);
        $context->runWithVisitorId('outer', static function () use ($middleware, $context): void {
            try {
                $middleware->process((new ServerRequest('GET', '/'))->withHeader('Cookie', '_cekat_visitor_id=inner'), new CallbackHandler(static function () use ($context): never {
                    self::assertSame('inner', $context->current());
                    throw new \DomainException('downstream failure');
                }));
                self::fail('Expected exception');
            } catch (\DomainException) {
            }
            self::assertSame('outer', $context->current());
        });
        self::assertNull($context->current());
    }

    public function testAcceptsCustomContextAndDefaultsToSharedContext(): void
    {
        $custom = new class implements VisitorContextInterface {
            /** @var list<?string> */
            public array $scopes = [];

            public function current(): ?string
            {
                return null;
            }

            public function replace(?string $visitorId): ?string
            {
                return null;
            }

            public function restore(?string $previous): void {}

            public function runWithVisitorId(?string $visitorId, callable $handler): mixed
            {
                $this->scopes[] = $visitorId;

                return $handler();
            }

            public function runWithPsrRequest(ServerRequestInterface $request, callable $handler): mixed
            {
                return $this->runWithVisitorId($request->getHeaderLine('X-Cekat-Visitor-ID'), $handler);
            }
        };
        (new VisitorMiddleware($custom))->process((new ServerRequest('GET', '/'))->withHeader('X-Cekat-Visitor-ID', 'custom'), new CallbackHandler(static fn(): ResponseInterface => new Response()));
        self::assertSame(['custom'], $custom->scopes);

        $observed = null;
        (new VisitorMiddleware())->process((new ServerRequest('GET', '/'))->withHeader('X-Cekat-Visitor-ID', 'shared'), new CallbackHandler(static function () use (&$observed): ResponseInterface {
            $observed = VisitorContext::shared()->current();

            return new Response();
        }));
        self::assertSame('shared', $observed);
        self::assertNull(VisitorContext::shared()->current());
    }
}

final class CallbackHandler implements RequestHandlerInterface
{
    /** @param \Closure(ServerRequestInterface): ResponseInterface $callback */
    public function __construct(private readonly \Closure $callback) {}

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        return ($this->callback)($request);
    }
}
