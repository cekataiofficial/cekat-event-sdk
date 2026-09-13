<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Integration\Laravel;

use Cekat\EventSdk\Client;
use Cekat\EventSdk\ClientOptions;
use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Context\VisitorContextInterface;
use Cekat\EventSdk\Exception\ValidationException;
use Cekat\EventSdk\Transport\GuzzleTransport;
use Cekat\EventSdk\Transport\Transport;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\ServiceProvider;

/**
 * Registers the Cekat client from config('services.cekat'):
 *
 *     'cekat' => [
 *         'access_token' => env('CEKAT_ACCESS_TOKEN'),
 *         'base_url' => env('CEKAT_BASE_URL'),        // optional
 *         'timeout_seconds' => 3.0,                   // optional
 *         'retry_count' => 2,                         // optional
 *     ],
 *
 * The visitor context and client are scoped bindings, so Octane rebuilds them per request.
 */
final class CekatServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(Transport::class, static fn(): Transport => new GuzzleTransport());
        $this->app->scoped(VisitorContextInterface::class, static fn(): VisitorContextInterface => new VisitorContext());
        $this->app->scoped(Client::class, static function (Application $app): Client {
            /** @var array<string, mixed> $config */
            $config = (array) $app->make('config')->get('services.cekat', []);
            $token = $config['access_token'] ?? null;
            if (!is_string($token) || trim($token) === '') {
                throw new ValidationException('services.cekat.access_token must be configured');
            }
            $baseUrl = $config['base_url'] ?? null;
            $timeout = $config['timeout_seconds'] ?? null;
            $retries = $config['retry_count'] ?? null;

            return new Client(
                $token,
                new ClientOptions(
                    is_string($baseUrl) && $baseUrl !== '' ? $baseUrl : ClientOptions::DEFAULT_BASE_URL,
                    is_numeric($timeout) ? (float) $timeout : 3.0,
                    is_numeric($retries) ? (int) $retries : 2,
                ),
                $app->make(Transport::class),
                $app->make(VisitorContextInterface::class),
            );
        });
    }
}
