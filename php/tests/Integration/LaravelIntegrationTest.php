<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Integration;

use Cekat\EventSdk\Client;
use Cekat\EventSdk\Context\VisitorContextInterface;
use Cekat\EventSdk\EventInput;
use Cekat\EventSdk\Exception\ValidationException;
use Cekat\EventSdk\Integration\Laravel\CekatServiceProvider;
use Cekat\EventSdk\Integration\Laravel\VisitorMiddleware;
use Cekat\EventSdk\Tests\Support\FakeTransport;
use Cekat\EventSdk\Transport\Transport;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Orchestra\Testbench\TestCase;

final class LaravelIntegrationTest extends TestCase
{
    private FakeTransport $transport;

    protected function getPackageProviders($app): array
    {
        return [CekatServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        /** @var Repository $config */
        $config = $app->make('config');
        $config->set('services.cekat', ['access_token' => 'laravel-token', 'base_url' => 'https://ingest.example.test', 'timeout_seconds' => 1.5, 'retry_count' => 0]);
        $config->set('app.key', 'base64:' . base64_encode(str_repeat('k', 32)));
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->transport = new FakeTransport();
        $this->application()->instance(Transport::class, $this->transport);
    }

    private function application(): \Illuminate\Foundation\Application
    {
        self::assertNotNull($this->app);

        return $this->app;
    }

    protected function defineRoutes($router): void
    {
        Route::middleware(['web', VisitorMiddleware::class])->post('/orders', static function (Request $request, Client $client) {
            $client->orderPaid(125000, 'IDR', new EventInput(email: 'buyer@example.test', properties: ['order_id' => (string) $request->input('order_id')]));

            return response()->json(['visitor' => app(VisitorContextInterface::class)->current()]);
        });
        Route::middleware(VisitorMiddleware::class)->get('/boom', static function (): never {
            throw new \RuntimeException('downstream failure');
        });
    }

    public function testConfiguresClientAndScopesVisitorThroughTheWebPipeline(): void
    {
        $this->withoutMiddleware(\Illuminate\Foundation\Http\Middleware\ValidateCsrfToken::class);
        $response = $this->call('POST', '/orders', ['order_id' => 'ord-1'], [], [], ['HTTP_X_CEKAT_VISITOR_ID' => ' header-visitor ', 'HTTP_COOKIE' => '_cekat_visitor_id=cookie']);
        $response->assertOk()->assertJson(['visitor' => 'header-visitor']);

        // An unencrypted browser cookie survives EncryptCookies because the raw header is read.
        $this->call('POST', '/orders', ['order_id' => 'ord-2'], [], [], ['HTTP_COOKIE' => '_cekat_visitor_id=browser-cookie'])->assertOk();
        $this->call('POST', '/orders', ['order_id' => 'ord-3'])->assertOk()->assertJson(['visitor' => null]);

        self::assertSame('https://ingest.example.test/api/events/ingest', $this->transport->requests[0]->url);
        self::assertSame('Bearer laravel-token', $this->transport->requests[0]->headers['Authorization']);
        self::assertSame([1.5, 1.5, 1.5], $this->transport->timeouts);
        self::assertSame('header-visitor', $this->transport->payload(0)['visitor_id']);
        self::assertSame(['order_id' => 'ord-1', 'amount' => 125000, 'currency' => 'IDR'], $this->transport->payload(0)['properties']);
        self::assertSame('browser-cookie', $this->transport->payload(1)['visitor_id']);
        self::assertArrayNotHasKey('visitor_id', $this->transport->payload(2));
    }

    public function testExceptionsRestoreScopeAndScopedBindingsAreRebuilt(): void
    {
        $this->call('GET', '/boom', [], [], [], ['HTTP_X_CEKAT_VISITOR_ID' => 'failing'])->assertStatus(500);
        $context = $this->application()->make(VisitorContextInterface::class);
        self::assertNull($context->current());
        self::assertSame($context, $this->application()->make(VisitorContextInterface::class));

        $client = $this->application()->make(Client::class);
        $this->application()->forgetScopedInstances();
        self::assertNotSame($context, $this->application()->make(VisitorContextInterface::class));
        self::assertNotSame($client, $this->application()->make(Client::class));
    }

    public function testMissingAccessTokenFailsWhenClientIsResolved(): void
    {
        $this->application()->make('config')->set('services.cekat.access_token', ' ');
        $this->application()->forgetScopedInstances();
        $this->expectException(ValidationException::class);
        $this->application()->make(Client::class);
    }
}
