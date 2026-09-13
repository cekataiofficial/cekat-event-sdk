<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Integration;

use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Integration\Symfony\VisitorContextKernel;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\HttpKernelInterface;
use Symfony\Component\HttpKernel\TerminableInterface;

final class SymfonyIntegrationTest extends TestCase
{
    public function testMainRequestUsesHeaderThenRawCookieAndRestores(): void
    {
        $context = new VisitorContext();
        $inner = new RecordingKernel($context);
        $kernel = new VisitorContextKernel($inner, $context);

        $withHeader = Request::create('/', 'POST', server: ['HTTP_X_CEKAT_VISITOR_ID' => ' header ', 'HTTP_COOKIE' => '_cekat_visitor_id=cookie']);
        $response = $kernel->handle($withHeader);
        self::assertSame(202, $response->getStatusCode());
        $kernel->handle(Request::create('/', server: ['HTTP_COOKIE' => '_cekat_visitor_id= cookie ']));
        $kernel->handle(Request::create('/', cookies: ['_cekat_visitor_id' => 'parsed']));
        $kernel->handle(Request::create('/'));

        self::assertSame(['header', 'cookie', 'parsed', null], $inner->observed);
        self::assertNull($context->current());
    }

    public function testSubRequestsInheritOrOverrideAndExceptionsRestore(): void
    {
        $context = new VisitorContext();
        $inner = new RecordingKernel($context);
        $kernel = new VisitorContextKernel($inner, $context);
        $inner->onHandle = static function (Request $request, int $type) use ($kernel): void {
            if ($type === HttpKernelInterface::MAIN_REQUEST && $request->getPathInfo() === '/main') {
                $kernel->handle(Request::create('/fragment'), HttpKernelInterface::SUB_REQUEST);
                $kernel->handle(Request::create('/other', server: ['HTTP_X_CEKAT_VISITOR_ID' => 'sub']), HttpKernelInterface::SUB_REQUEST);
            }
            if ($request->getPathInfo() === '/boom') {
                throw new \RuntimeException('kernel failure');
            }
        };

        $kernel->handle(Request::create('/main', server: ['HTTP_X_CEKAT_VISITOR_ID' => 'outer']));
        self::assertSame(['outer', 'sub', 'outer'], $inner->observed);

        try {
            $kernel->handle(Request::create('/boom', server: ['HTTP_X_CEKAT_VISITOR_ID' => 'failing']));
            self::fail('Expected exception');
        } catch (\RuntimeException) {
        }
        self::assertNull($context->current());
        $kernel->handle(Request::create('/after'));
        self::assertNull(end($inner->observed));
    }

    public function testForwardsTerminate(): void
    {
        $context = new VisitorContext();
        $inner = new RecordingKernel($context);
        (new VisitorContextKernel($inner, $context))->terminate(Request::create('/'), new Response());
        self::assertTrue($inner->terminated);
    }
}

final class RecordingKernel implements HttpKernelInterface, TerminableInterface
{
    /** @var list<?string> */
    public array $observed = [];

    public bool $terminated = false;

    /** @var (\Closure(Request, int): void)|null */
    public ?\Closure $onHandle = null;

    public function __construct(private readonly VisitorContext $context) {}

    public function handle(Request $request, int $type = self::MAIN_REQUEST, bool $catch = true): Response
    {
        if ($this->onHandle !== null) {
            ($this->onHandle)($request, $type);
        }
        // Record after nested sub-requests so the list shows the restored outer value.
        $this->observed[] = $this->context->current();

        return new Response('', 202);
    }

    public function terminate(Request $request, Response $response): void
    {
        $this->terminated = true;
    }
}
