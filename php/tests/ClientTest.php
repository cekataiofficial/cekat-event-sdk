<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests;

use Cekat\EventSdk\Client;
use Cekat\EventSdk\ClientOptions;
use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Context\VisitorContextInterface;
use Cekat\EventSdk\EventInput;
use Cekat\EventSdk\Exception\ApiException;
use Cekat\EventSdk\Exception\ResponseDecodeException;
use Cekat\EventSdk\Exception\TransportException;
use Cekat\EventSdk\Exception\ValidationException;
use Cekat\EventSdk\Tests\Support\FakeTransport;
use Cekat\EventSdk\Tests\Support\RecordingSleeper;
use Cekat\EventSdk\Transport\TransportFailure;
use Cekat\EventSdk\Transport\TransportResponse;
use GuzzleHttp\Psr7\ServerRequest;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    private const TOKEN = 'token-that-must-not-leak';

    private RecordingSleeper $sleeper;

    protected function setUp(): void
    {
        $this->sleeper = new RecordingSleeper();
    }

    /** @param (\Closure(int): int)|null $random */
    private function client(FakeTransport $transport, ?ClientOptions $options = null, ?VisitorContextInterface $context = null, ?\Closure $random = null): Client
    {
        return new Client(self::TOKEN, $options ?? new ClientOptions('https://ingest.example.test/'), $transport, $context ?? new VisitorContext(), $this->sleeper, $random ?? static fn(int $max): int => 0);
    }

    public function testPostsFixedEndpointWithHeadersAndReturnsAcknowledgement(): void
    {
        $transport = new FakeTransport();
        $ack = $this->client($transport)->userLogin(new EventInput(email: 'ada@example.test'));

        self::assertSame('accepted', $ack->message);
        self::assertCount(1, $transport->requests);
        $request = $transport->requests[0];
        self::assertSame('POST', $request->method);
        self::assertSame('https://ingest.example.test/api/events/ingest', $request->url);
        self::assertSame('Bearer ' . self::TOKEN, $request->headers['Authorization']);
        self::assertSame('application/json', $request->headers['Content-Type']);
        self::assertSame('cekat-event-sdk-php/' . Client::VERSION . ' php/' . PHP_VERSION, $request->headers['User-Agent']);
        self::assertSame([3.0], $transport->timeouts);
        self::assertArrayNotHasKey('business_id', $transport->payload());
    }

    public function testMapsAllOperationsToKeysCommonFlagsAndOrderPaidArguments(): void
    {
        $transport = new FakeTransport();
        $client = $this->client($transport);
        $event = new EventInput(email: 'ada@example.test', properties: ['order' => 'A-1']);
        $client->userRegistration($event);
        $client->userLogin($event);
        $client->orderCreated($event);
        $client->orderPaid(125.75, 'IDR', $event);
        $client->customEvent('trial_started', $event);

        $summary = array_map(static fn(int $index): array => array_intersect_key($transport->payload($index), array_flip(['event_key', 'is_common', 'properties'])), range(0, 4));
        self::assertSame([
            ['event_key' => 'user_registration', 'is_common' => true, 'properties' => ['order' => 'A-1']],
            ['event_key' => 'user_login', 'is_common' => true, 'properties' => ['order' => 'A-1']],
            ['event_key' => 'order_created', 'is_common' => true, 'properties' => ['order' => 'A-1']],
            ['event_key' => 'order_paid', 'is_common' => true, 'properties' => ['order' => 'A-1', 'amount' => 125.75, 'currency' => 'IDR']],
            ['event_key' => 'trial_started', 'is_common' => false, 'properties' => ['order' => 'A-1']],
        ], $summary);
    }

    public function testValidationHappensBeforeAnyRequest(): void
    {
        $transport = new FakeTransport();
        $client = $this->client($transport);
        foreach ([
            static fn() => $client->userLogin(new EventInput(contactName: 'Ada')),
            static fn() => $client->customEvent(' ', new EventInput(email: 'ada@example.test')),
            static fn() => $client->orderPaid(NAN, 'IDR', new EventInput(email: 'ada@example.test')),
            static fn() => $client->orderPaid(1, ' ', new EventInput(email: 'ada@example.test')),
            static fn() => $client->orderPaid(1, 'IDR', new EventInput(email: 'ada@example.test', properties: ['currency' => 'USD'])),
        ] as $call) {
            try {
                $call();
                self::fail('Expected ValidationException');
            } catch (ValidationException) {
            }
        }
        self::assertSame([], $transport->requests);
        $this->expectException(ValidationException::class);
        new Client(" \t");
    }

    public function testUsesInjectedVisitorContextWithExplicitVisitorPrecedence(): void
    {
        $transport = new FakeTransport();
        $context = new VisitorContext();
        $client = $this->client($transport, context: $context);
        $request = (new ServerRequest('GET', '/'))->withHeader('X-Cekat-Visitor-ID', ' from-request ');
        $context->runWithPsrRequest($request, static function () use ($client): void {
            $client->userLogin(new EventInput(email: 'ada@example.test'));
            $client->userLogin(new EventInput(email: 'ada@example.test', visitorId: ' explicit '));
            $client->userLogin(new EventInput(email: 'ada@example.test', visitorId: ' '));
        });
        $client->userLogin(new EventInput(email: 'ada@example.test'));

        self::assertSame('from-request', $transport->payload(0)['visitor_id']);
        self::assertSame('explicit', $transport->payload(1)['visitor_id']);
        self::assertSame('from-request', $transport->payload(2)['visitor_id']);
        self::assertArrayNotHasKey('visitor_id', $transport->payload(3));
    }

    /** @return iterable<string, array{int}> */
    public static function transientStatuses(): iterable
    {
        foreach ([429, 500, 502, 503, 504] as $status) {
            yield (string) $status => [$status];
        }
    }

    #[DataProvider('transientStatuses')]
    public function testRetriesTransientStatusWithIdenticalBody(int $status): void
    {
        $transport = new FakeTransport([FakeTransport::response($status, 'transient'), FakeTransport::success()]);
        $this->client($transport)->orderPaid(1, 'IDR', new EventInput(email: 'ada@example.test'));
        self::assertCount(2, $transport->requests);
        self::assertSame($transport->requests[0]->body, $transport->requests[1]->body);
    }

    public function testDoesNotRetryPermanentStatuses(): void
    {
        foreach ([400, 401, 404, 409, 422, 501] as $status) {
            $transport = new FakeTransport([FakeTransport::response($status, '{"success":false,"error":"permanent"}')]);
            try {
                $this->client($transport)->userLogin(new EventInput(email: 'ada@example.test'));
                self::fail('Expected ApiException');
            } catch (ApiException $error) {
                self::assertSame($status, $error->statusCode);
                self::assertSame(1, $error->attempts);
            }
            self::assertCount(1, $transport->requests);
        }
        self::assertSame([], $this->sleeper->sleeps);
    }

    public function testExhaustsRetriesWithCappedExponentialJitterBounds(): void
    {
        $transport = new FakeTransport(array_fill(0, 7, FakeTransport::response(500, '{"success":false,"error":"temporary"}')));
        $bounds = [];
        $client = $this->client($transport, new ClientOptions(retryCount: 6), random: static function (int $max) use (&$bounds): int {
            $bounds[] = $max;

            return $max;
        });
        try {
            $client->userLogin(new EventInput(email: 'ada@example.test'));
            self::fail('Expected ApiException');
        } catch (ApiException $error) {
            self::assertSame(7, $error->attempts);
            self::assertSame(500, $error->statusCode);
        }
        self::assertSame([100, 200, 400, 800, 1000, 1000], $bounds);
        self::assertSame([100, 200, 400, 800, 1000, 1000], $this->sleeper->sleeps);
    }

    public function testTransportFailuresRetryThenReportUnknownOutcomeWithoutToken(): void
    {
        $transport = new FakeTransport([
            TransportFailure::from(new \RuntimeException('connection reset')),
            FakeTransport::response(503, ''),
            TransportFailure::from(new \RuntimeException('final failure')),
        ]);
        try {
            $this->client($transport)->userLogin(new EventInput(email: 'ada@example.test'));
            self::fail('Expected TransportException');
        } catch (TransportException $error) {
            self::assertSame(3, $error->attempts);
            self::assertTrue($error->deliveryOutcomeUnknown);
            self::assertInstanceOf(TransportFailure::class, $error->getPrevious());
            self::assertStringContainsString('final failure', $error->getPrevious()->getMessage());
            self::assertNull($error->getPrevious()->getPrevious());
            self::assertStringNotContainsString(self::TOKEN, $error->getMessage() . $error->getPrevious()->getMessage() . $error->getTraceAsString());
        }
    }

    public function testRetryAfterRaisesDelayAndStopsBeyondFiveSeconds(): void
    {
        $transport = new FakeTransport([
            FakeTransport::response(429, 'slow down', ['Retry-After' => ['2']]),
            FakeTransport::response(503, 'slow down', ['retry-after' => ['soon']]),
            FakeTransport::success(),
        ]);
        $this->client($transport, random: static fn(int $max): int => intdiv($max, 2))->userLogin(new EventInput(email: 'ada@example.test'));
        self::assertSame([2000, 100], $this->sleeper->sleeps);

        $capped = new FakeTransport([FakeTransport::response(503, 'maintenance', ['Retry-After' => ['6']], 'Service Unavailable')]);
        try {
            $this->client($capped)->userLogin(new EventInput(email: 'ada@example.test'));
            self::fail('Expected ApiException');
        } catch (ApiException $error) {
            self::assertSame(503, $error->statusCode);
            self::assertSame(1, $error->attempts);
            self::assertSame('Service Unavailable', $error->getMessage());
        }
        self::assertCount(1, $capped->requests);
    }

    public function testInterruptedSuccessBodyIsNeverRetriedButRetryableStatusIs(): void
    {
        $failure = new \RuntimeException('reset');
        $accepted = new FakeTransport([new TransportResponse(200, [], '{"success":tr', 'OK', false, 13, $failure)]);
        try {
            $this->client($accepted)->userLogin(new EventInput(email: 'ada@example.test'));
            self::fail('Expected ResponseDecodeException');
        } catch (ResponseDecodeException $error) {
            self::assertSame(1, $error->attempts);
            self::assertFalse($error->deliveryOutcomeUnknown);
        }
        self::assertCount(1, $accepted->requests);

        $retryable = new FakeTransport([new TransportResponse(500, [], '', '', false, 0, $failure), FakeTransport::success()]);
        $this->client($retryable)->userLogin(new EventInput(email: 'ada@example.test'));
        self::assertCount(2, $retryable->requests);
    }
}
