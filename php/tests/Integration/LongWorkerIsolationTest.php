<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Integration;

use Cekat\EventSdk\Client;
use Cekat\EventSdk\ClientOptions;
use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\EventInput;
use Cekat\EventSdk\Integration\Psr15\VisitorMiddleware;
use Cekat\EventSdk\Tests\Support\FakeTransport;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Psr7\ServerRequest;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;

final class LongWorkerIsolationTest extends TestCase
{
    public function testSequentialWorkerRequestsNeverLeakVisitorIds(): void
    {
        $context = new VisitorContext();
        $transport = new FakeTransport();
        $client = new Client('token', new ClientOptions(), $transport, $context);
        $middleware = new VisitorMiddleware($context);

        $expected = [];
        for ($index = 0; $index < 60; $index++) {
            $request = new ServerRequest('POST', '/orders');
            $visitor = null;
            if ($index % 3 === 0) {
                $visitor = 'visitor-' . $index;
                $request = $request->withHeader('X-Cekat-Visitor-ID', $visitor);
            }
            $throws = $index % 5 === 0;
            try {
                $middleware->process($request, new CallbackHandler(static function () use ($client, $throws): ResponseInterface {
                    $client->userLogin(new EventInput(email: 'worker@example.test'));
                    if ($throws) {
                        throw new \RuntimeException('handler failed');
                    }

                    return new Response();
                }));
            } catch (\RuntimeException) {
            }
            $expected[] = $visitor;
            self::assertNull($context->current(), 'visitor leaked after request ' . $index);
        }

        $sent = array_map(static fn(int $index): mixed => $transport->payload($index)['visitor_id'] ?? null, range(0, 59));
        self::assertSame($expected, $sent);
    }
}
