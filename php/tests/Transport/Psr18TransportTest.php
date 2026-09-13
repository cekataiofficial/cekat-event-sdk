<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Transport;

use Cekat\EventSdk\Transport\Psr18Transport;
use Cekat\EventSdk\Transport\TransportFailure;
use Cekat\EventSdk\Transport\TransportRequest;
use GuzzleHttp\Psr7\HttpFactory;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Psr7\Utils;
use PHPUnit\Framework\TestCase;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

final class Psr18TransportTest extends TestCase
{
    public function testSendsPsr7RequestAndBoundsResponse(): void
    {
        $body = str_repeat('a', 70000);
        $client = new class ($body) implements ClientInterface {
            public ?RequestInterface $request = null;

            public function __construct(private readonly string $body) {}

            public function sendRequest(RequestInterface $request): ResponseInterface
            {
                $this->request = $request;

                return new Response(503, ['Retry-After' => '2'], $this->body, '1.1', 'Try Later');
            }
        };
        $factory = new HttpFactory();
        $response = (new Psr18Transport($client, $factory, $factory))->send(new TransportRequest('POST', 'https://ingest.example.test/api/events/ingest', ['Authorization' => 'Bearer t'], '{"a":1}'), 3.0);

        self::assertNotNull($client->request);
        self::assertSame('POST', $client->request->getMethod());
        self::assertSame('Bearer t', $client->request->getHeaderLine('Authorization'));
        self::assertSame('{"a":1}', (string) $client->request->getBody());
        self::assertSame(503, $response->status);
        self::assertSame('Try Later', $response->reasonPhrase);
        self::assertSame('2', $response->header('Retry-After'));
        self::assertTrue($response->bodyTruncated);
        self::assertSame(65536, strlen($response->body));
        self::assertSame(65537, $response->observedBodyBytes);
    }

    public function testMapsClientExceptionsAndBodyReadFailures(): void
    {
        $factory = new HttpFactory();
        $failing = new class implements ClientInterface {
            public function sendRequest(RequestInterface $request): ResponseInterface
            {
                throw new class ('network down') extends \RuntimeException implements ClientExceptionInterface {};
            }
        };
        try {
            (new Psr18Transport($failing, $factory, $factory))->send(new TransportRequest('POST', 'https://x.test/', [], '{}'), 1.0);
            self::fail('Expected TransportFailure');
        } catch (TransportFailure $failure) {
            self::assertStringContainsString('network down', $failure->getMessage());
        }

        $brokenBody = new class implements ClientInterface {
            public function sendRequest(RequestInterface $request): ResponseInterface
            {
                $stream = Utils::streamFor('');

                return (new Response(200))->withBody(new class ($stream) implements \Psr\Http\Message\StreamInterface {
                    use \GuzzleHttp\Psr7\StreamDecoratorTrait;

                    public function __construct(protected \Psr\Http\Message\StreamInterface $stream) {}

                    public function eof(): bool
                    {
                        return false;
                    }

                    public function read(int $length): string
                    {
                        throw new \RuntimeException('socket reset');
                    }
                });
            }
        };
        $response = (new Psr18Transport($brokenBody, $factory, $factory))->send(new TransportRequest('POST', 'https://x.test/', [], '{}'), 1.0);
        self::assertSame(200, $response->status);
        self::assertInstanceOf(TransportFailure::class, $response->bodyReadFailure);
    }
}
