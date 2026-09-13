<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Conformance;

use Cekat\EventSdk\Acknowledgement;
use Cekat\EventSdk\Client;
use Cekat\EventSdk\ClientOptions;
use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\EventInput;
use Cekat\EventSdk\Exception\ApiException;
use Cekat\EventSdk\Exception\AuthenticationException;
use Cekat\EventSdk\Exception\EventDefinitionNotFoundException;
use Cekat\EventSdk\Exception\ResponseDecodeException;
use Cekat\EventSdk\Exception\TransportException;
use Cekat\EventSdk\Exception\ValidationException;
use Cekat\EventSdk\Tests\Support\RecordingSleeper;
use Cekat\EventSdk\Transport\GuzzleTransport;
use Cekat\EventSdk\Transport\Transport;
use Cekat\EventSdk\Transport\TransportRequest;
use Cekat\EventSdk\Transport\TransportResponse;
use GuzzleHttp\Client as Http;
use GuzzleHttp\Psr7\ServerRequest;
use Opis\JsonSchema\Validator;
use PHPUnit\Framework\TestCase;

/**
 * Executes every shared fixture against the mock ingest server. Driven only by the four
 * CEKAT_CONFORMANCE_* variables that php/scripts/conformance validates.
 */
final class SharedFixturesTest extends TestCase
{
    private const SCHEMA_BASE = 'https://schemas.cekat.ai/event-sdk/conformance/';
    private const REQUIRED_ENV = ['CEKAT_CONFORMANCE_BASE_URL', 'CEKAT_CONFORMANCE_CONTROL_URL', 'CEKAT_CONFORMANCE_ACCESS_TOKEN', 'CEKAT_CONFORMANCE_FIXTURES'];
    private const EVENT_ID = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';
    private const OCCURRED_AT = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/';
    private const USER_AGENT = '/^cekat-event-sdk-php\/\d+\.\d+\.\d+\S*( .+)?$/';

    private Http $control;
    private string $controlUrl;

    public function testSchemasRejectMalformedFixtures(): void
    {
        $validator = self::validator(dirname(__DIR__, 3) . '/conformance/fixtures/schemas');
        $fixture = self::decode((string) file_get_contents(dirname(__DIR__, 3) . '/conformance/fixtures/cases/retry-500-500-success.json'));
        self::assertTrue($validator->validate($fixture, self::SCHEMA_BASE . 'conformance-case.schema.json')->isValid());
        foreach ([
            static function (\stdClass $case): void {
                $case->responses[0]->headers = 1;
            },
            static function (\stdClass $case): void {
                $case->expect->status = '400';
            },
            static function (\stdClass $case): void {
                $case->expect->request->extra = true;
            },
            static function (\stdClass $case): void {
                unset($case->operation->currency);
            },
            static function (\stdClass $case): void {
                $case->expect->jitter_bounds_ms = [[0, 101], [0, 200]];
            },
        ] as $mutate) {
            $invalid = self::decode((string) json_encode($fixture));
            $mutate($invalid);
            self::assertFalse($validator->validate($invalid, self::SCHEMA_BASE . 'conformance-case.schema.json')->isValid());
        }
    }

    public function testSharedConformance(): void
    {
        $environment = [];
        foreach (self::REQUIRED_ENV as $name) {
            $value = getenv($name);
            if (!is_string($value) || $value === '') {
                self::fail($name . ' is required; run php/scripts/conformance');
            }
            $environment[$name] = $value;
        }
        foreach (array_keys(getenv()) as $name) {
            if (str_starts_with($name, 'CEKAT_CONFORMANCE_') && !in_array($name, self::REQUIRED_ENV, true)) {
                self::fail('unrecognized conformance environment variable ' . $name);
            }
        }
        $directory = $environment['CEKAT_CONFORMANCE_FIXTURES'];
        self::assertTrue(str_starts_with($directory, '/') && is_dir($directory), 'CEKAT_CONFORMANCE_FIXTURES must be an absolute directory');
        $validator = self::validator(dirname($directory) . '/schemas');
        $this->controlUrl = $environment['CEKAT_CONFORMANCE_CONTROL_URL'];
        $this->control = new Http(['http_errors' => false, 'timeout' => 10]);

        $files = glob($directory . '/*.json') ?: [];
        sort($files);
        self::assertNotEmpty($files, 'fixture corpus contains no direct JSON files');
        $discovered = [];
        $passed = [];
        $notApplicable = [];
        foreach ($files as $file) {
            $fixture = self::decode((string) file_get_contents($file));
            $result = $validator->validate($fixture, self::SCHEMA_BASE . 'conformance-case.schema.json');
            self::assertTrue($result->isValid(), basename($file) . ' violates the shared schema');
            self::assertSame(basename($file, '.json'), $fixture->id, 'filename/ID mismatch');
            self::assertArrayNotHasKey($fixture->id, $discovered, 'duplicate fixture ID ' . $fixture->id);
            $discovered[$fixture->id] = true;

            if (in_array('php', $fixture->applicability->inapplicable_languages ?? [], true)) {
                self::assertSame('cancellation', $fixture->kind);
                self::assertSame(['caller_cancellation'], $fixture->applicability->requires_capabilities);
                $notApplicable[] = $fixture->id;
                fwrite(STDOUT, json_encode(['id' => $fixture->id, 'status' => 'not_applicable', 'capability' => 'caller_cancellation'], JSON_THROW_ON_ERROR) . "\n");
                continue;
            }
            $this->execute($fixture, $environment, $validator);
            $passed[] = $fixture->id;
            fwrite(STDOUT, json_encode(['id' => $fixture->id, 'status' => 'passed'], JSON_THROW_ON_ERROR) . "\n");
        }

        $accounted = array_merge($passed, $notApplicable);
        sort($accounted);
        $ids = array_keys($discovered);
        sort($ids);
        self::assertSame($ids, $accounted, 'every discovered fixture must be passed or not_applicable exactly once');
    }

    /** @param array<string, string> $environment */
    private function execute(\stdClass $fixture, array $environment, Validator $validator): void
    {
        $this->post('/__control/reset', null);
        $responses = [];
        foreach ($fixture->responses ?? [] as $response) {
            $responses[] = clone $response;
        }
        $expandedBody = isset($fixture->response_body_recipe) ? self::expandBody($fixture->response_body_recipe) : null;
        if ($expandedBody !== null) {
            self::assertCount(1, $responses, 'response-body recipe requires exactly one response');
            $responses[0]->body = $expandedBody;
        }
        $this->post('/__control/responses', ['responses' => $responses]);

        $transport = new RecordingTransport(new GuzzleTransport());
        $sleeper = new RecordingSleeper();
        $context = new VisitorContext();
        $client = new Client(
            $environment['CEKAT_CONFORMANCE_ACCESS_TOKEN'],
            new ClientOptions(
                $environment['CEKAT_CONFORMANCE_BASE_URL'],
                isset($fixture->client->timeout_ms) ? $fixture->client->timeout_ms / 1000 : 3.0,
                $fixture->client->retry_count ?? 2,
            ),
            $transport,
            $context,
            $sleeper,
            static fn(int $max): int => intdiv($max, 2),
        );

        $invoke = fn(): Acknowledgement => $this->dispatch($client, $fixture->operation);
        $started = microtime(true);
        $result = null;
        $error = null;
        try {
            $inbound = $fixture->inbound ?? new \stdClass();
            if (isset($inbound->header_visitor_id) || isset($inbound->cookie_visitor_id)) {
                $request = new ServerRequest('GET', 'http://conformance.invalid/');
                if (isset($inbound->header_visitor_id)) {
                    $request = $request->withHeader('X-Cekat-Visitor-ID', $inbound->header_visitor_id);
                }
                if (isset($inbound->cookie_visitor_id)) {
                    $request = $request->withHeader('Cookie', '_cekat_visitor_id=' . $inbound->cookie_visitor_id);
                }
                $result = $context->runWithPsrRequest($request, $invoke);
            } elseif (isset($inbound->ambient_visitor_id)) {
                $result = $context->runWithVisitorId($inbound->ambient_visitor_id, $invoke);
            } else {
                $result = $invoke();
            }
        } catch (\Throwable $caught) {
            $error = $caught;
        }
        $finished = microtime(true);

        $this->assertResult($fixture, $result, $error, $transport, $expandedBody, $environment['CEKAT_CONFORMANCE_ACCESS_TOKEN']);
        $this->assertDelays($fixture->expect, $sleeper->sleeps);
        $this->assertJournal($fixture, $validator, $started, $finished);
    }

    private function dispatch(Client $client, \stdClass $operation): Acknowledgement
    {
        $source = $operation->event;
        $event = new EventInput(
            email: $source->email ?? null,
            phoneNumber: $source->phone_number ?? null,
            contactName: $source->contact_name ?? null,
            visitorId: $source->visitor_id ?? null,
            properties: isset($operation->properties_recipe) ? self::recipeProperties($operation->properties_recipe) : ($source->properties ?? null),
            eventId: $source->event_id ?? null,
            occurredAt: isset($source->occurred_at) ? new \DateTimeImmutable($source->occurred_at) : null,
        );

        return match ($operation->name) {
            'user_registration' => $client->userRegistration($event),
            'user_login' => $client->userLogin($event),
            'order_created' => $client->orderCreated($event),
            'order_paid' => $client->orderPaid($operation->amount, $operation->currency, $event),
            'custom_event' => $client->customEvent($operation->event_key, $event),
        };
    }

    /** @return array<string, mixed> */
    private static function recipeProperties(string $recipe): array
    {
        return match ($recipe) {
            'nan' => ['value' => NAN],
            'positive_infinity' => ['value' => INF],
            'negative_infinity' => ['value' => -INF],
            'unsafe_integer_high' => ['value' => 9007199254740992],
            'unsafe_integer_low' => ['value' => -9007199254740992],
            'cycle' => (static function (): array {
                $value = new \stdClass();
                $value->self = $value;

                return ['value' => $value];
            })(),
            // PHP arrays only have int or string keys; an integer-keyed map is the ambiguous non-string-key form.
            'non_string_key' => ['value' => [1 => 'one']],
            'runtime_object' => ['value' => new \ArrayObject(['runtime' => true])],
        };
    }

    private function assertResult(\stdClass $fixture, ?Acknowledgement $result, ?\Throwable $error, RecordingTransport $transport, ?string $expandedBody, string $token): void
    {
        $expect = $fixture->expect;
        $id = $fixture->id;
        if ($error !== null) {
            self::assertStringNotContainsString($token, $error->getMessage() . ($error->getPrevious()?->getMessage() ?? ''), $id);
        }
        if ($expect->result === 'acknowledgement') {
            self::assertNull($error, $id . ': ' . ($error?->getMessage() ?? ''));
            self::assertInstanceOf(Acknowledgement::class, $result, $id);
            self::assertTrue($result->success, $id);
            if (isset($expect->acknowledgement)) {
                self::assertSame($expect->acknowledgement->message, $result->message, $id);
                self::assertSame($expect->acknowledgement->event_key, $result->eventKey, $id);
                self::assertSame($expect->acknowledgement->validated_properties, $result->validatedProperties, $id);
            }
        } else {
            $class = match ($expect->result) {
                'validation_error' => ValidationException::class,
                'authentication_error' => AuthenticationException::class,
                'event_definition_not_found_error' => EventDefinitionNotFoundException::class,
                'api_error' => ApiException::class,
                'transport_error' => TransportException::class,
                'response_decode_error' => ResponseDecodeException::class,
            };
            self::assertNotNull($error, $id . ' expected ' . $expect->result);
            self::assertSame($class, $error::class, $id . ': ' . $error->getMessage());
            if ($error instanceof ApiException) {
                self::assertSame($expect->attempts, $error->attempts, $id);
                self::assertSame($expect->delivery_outcome_unknown ?? false, $error->deliveryOutcomeUnknown, $id);
                if (isset($expect->status)) {
                    self::assertSame($expect->status, $error->statusCode, $id);
                }
                if (isset($expect->error_message)) {
                    self::assertSame($expect->error_message, $error->getMessage(), $id);
                }
                if (isset($expect->server_error)) {
                    self::assertSame($expect->server_error, $error->getMessage(), $id);
                }
                if (isset($expect->server_code)) {
                    self::assertSame($expect->server_code, $error->serverCode, $id);
                }
                $this->assertRetainedBody($expect, $error->rawBody, $expandedBody, $id);
            }
            if ($error instanceof ResponseDecodeException) {
                self::assertSame($expect->attempts, $error->attempts, $id);
                self::assertFalse($error->deliveryOutcomeUnknown, $id);
                self::assertSame(200, $error->statusCode, $id);
                $this->assertRetainedBody($expect, $error->rawBody, $expandedBody, $id);
            }
            if ($error instanceof TransportException) {
                self::assertSame($expect->attempts, $error->attempts, $id);
                self::assertSame($expect->delivery_outcome_unknown ?? true, $error->deliveryOutcomeUnknown, $id);
            }
        }
        if (isset($expect->observed_body_bytes) || isset($expect->body_truncated)) {
            $last = $transport->last;
            self::assertNotNull($last, $id);
            self::assertSame($expect->observed_body_bytes, $last->observedBodyBytes, $id);
            self::assertSame($expect->body_truncated, $last->bodyTruncated, $id);
        }
    }

    private function assertRetainedBody(\stdClass $expect, string $rawBody, ?string $expandedBody, string $id): void
    {
        if (!isset($expect->retained_body_bytes)) {
            return;
        }
        self::assertSame($expect->retained_body_bytes, strlen($rawBody), $id);
        if ($expandedBody !== null) {
            self::assertSame(substr($expandedBody, 0, $expect->retained_body_bytes), $rawBody, $id);
        }
    }

    /** @param list<int> $sleeps */
    private function assertDelays(\stdClass $expect, array $sleeps): void
    {
        if (isset($expect->jitter_bounds_ms)) {
            self::assertCount(count($expect->jitter_bounds_ms), $sleeps);
            foreach ($expect->jitter_bounds_ms as $index => [$minimum, $maximum]) {
                self::assertGreaterThanOrEqual($minimum, $sleeps[$index]);
                self::assertLessThanOrEqual($maximum, $sleeps[$index]);
            }
        }
        if (isset($expect->minimum_retry_delays_ms)) {
            self::assertCount(count($expect->minimum_retry_delays_ms), $sleeps);
            foreach ($expect->minimum_retry_delays_ms as $index => $minimum) {
                self::assertGreaterThanOrEqual($minimum, $sleeps[$index]);
            }
        }
    }

    private function assertJournal(\stdClass $fixture, Validator $validator, float $started, float $finished): void
    {
        $response = $this->control->get($this->controlUrl . '/__control/requests');
        self::assertSame(200, $response->getStatusCode());
        $journal = self::decode((string) $response->getBody());
        self::assertTrue($validator->validate($journal, self::SCHEMA_BASE . 'request-journal.schema.json')->isValid(), 'journal violates schema');
        $expect = $fixture->expect;
        self::assertCount($expect->attempts, $journal->requests, $fixture->id);

        $generated = [];
        foreach ($journal->requests as $index => $entry) {
            $userAgent = $entry->headers->{'user-agent'} ?? [];
            self::assertCount(1, $userAgent, $fixture->id);
            self::assertMatchesRegularExpression(self::USER_AGENT, $userAgent[0]);
            if (!isset($expect->request)) {
                continue;
            }
            self::assertSame($index + 1, $entry->sequence);
            self::assertSame('POST', $entry->method);
            self::assertSame($expect->request->path, $entry->path);
            self::assertSame([$expect->request->authorization], $entry->headers->authorization);

            $actual = self::decode($entry->body);
            foreach (['event_id', 'occurred_at'] as $field) {
                if (property_exists($expect->request->payload, $field)) {
                    continue;
                }
                $value = $actual->{$field} ?? null;
                self::assertIsString($value, $fixture->id . ' ' . $field);
                if ($field === 'event_id') {
                    self::assertMatchesRegularExpression(self::EVENT_ID, $value);
                } else {
                    self::assertMatchesRegularExpression(self::OCCURRED_AT, $value);
                    $timestamp = (float) (new \DateTimeImmutable($value))->format('U.u');
                    self::assertGreaterThanOrEqual($started - 1, $timestamp);
                    self::assertLessThanOrEqual($finished + 1, $timestamp);
                }
                if (isset($generated[$field])) {
                    self::assertSame($generated[$field], $value, $fixture->id . ' reuses ' . $field);
                }
                $generated[$field] = $value;
                unset($actual->{$field});
            }
            self::assertSame(self::canonical($expect->request->payload), self::canonical($actual), $fixture->id . ' payload');
        }
    }

    private function post(string $path, mixed $body): void
    {
        $options = $body === null ? [] : ['body' => json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'headers' => ['Content-Type' => 'application/json']];
        $response = $this->control->post($this->controlUrl . $path, $options);
        self::assertSame(204, $response->getStatusCode(), 'mock control ' . $path);
    }

    private static function expandBody(\stdClass $recipe): string
    {
        $body = '';
        while (strlen($body) < $recipe->minimum_utf8_bytes) {
            $body .= $recipe->unit;
        }

        return $body . $recipe->suffix;
    }

    /** Type-preserving, key-order-insensitive representation of a decoded JSON value. */
    private static function canonical(mixed $value): mixed
    {
        if ($value instanceof \stdClass) {
            $members = get_object_vars($value);
            ksort($members);

            return ['object' => array_map(self::canonical(...), $members)];
        }
        if (is_array($value)) {
            return ['list' => array_map(self::canonical(...), $value)];
        }

        return is_int($value) ? (float) $value : $value;
    }

    private static function decode(string $json): mixed
    {
        return json_decode($json, false, 512, JSON_THROW_ON_ERROR);
    }

    private static function validator(string $schemaDirectory): Validator
    {
        $validator = new Validator();
        foreach (glob($schemaDirectory . '/*.schema.json') ?: [] as $file) {
            $validator->resolver()?->registerFile(self::SCHEMA_BASE . basename($file), $file);
        }

        return $validator;
    }
}

final class RecordingTransport implements Transport
{
    public ?TransportResponse $last = null;

    public function __construct(private readonly Transport $inner) {}

    public function send(TransportRequest $request, float $timeoutSeconds): TransportResponse
    {
        return $this->last = $this->inner->send($request, $timeoutSeconds);
    }
}
