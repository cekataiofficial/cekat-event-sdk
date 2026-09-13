<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Unit;

use Cekat\EventSdk\EventInput;
use Cekat\EventSdk\Exception\ValidationException;
use Cekat\EventSdk\Internal\PayloadBuilder;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class PayloadBuilderTest extends TestCase
{
    private const UUID_V4 = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';

    private function builder(): PayloadBuilder
    {
        return new PayloadBuilder(
            static fn(): \DateTimeImmutable => new \DateTimeImmutable('2026-09-13T01:15:30.250999Z'),
            static fn(): string => 'generated-event-id',
        );
    }

    /** @return array<string, mixed> */
    private function build(string $eventKey, EventInput $event, ?string $ambient = null, bool $isCommon = true): array
    {
        /** @var array<string, mixed> $payload */
        $payload = json_decode($this->builder()->build($eventKey, $isCommon, $event, $ambient), true, 512, JSON_THROW_ON_ERROR);

        return $payload;
    }

    public function testBuildsExactPayloadPreservingIdentityWhitespaceAndTrimmingVisitor(): void
    {
        $payload = $this->build(' custom_event ', new EventInput(
            email: ' ada@example.test ',
            phoneNumber: ' +628123 ',
            contactName: ' Ada ',
            visitorId: " explicit-visitor\t",
            properties: ['nested' => ['value', 12.5, null]],
        ), ' ambient ', false);

        self::assertSame([
            'event_key' => ' custom_event ',
            'event_id' => 'generated-event-id',
            'occurred_at' => '2026-09-13T01:15:30.250Z',
            'is_common' => false,
            'email' => ' ada@example.test ',
            'phone_number' => ' +628123 ',
            'contact_name' => ' Ada ',
            'visitor_id' => 'explicit-visitor',
            'properties' => ['nested' => ['value', 12.5, null]],
        ], $payload);
    }

    public function testBlankExplicitVisitorFallsBackToAmbientAndBlankAmbientIsOmitted(): void
    {
        self::assertSame('ambient', $this->build('user_login', new EventInput(email: 'a@example.test', visitorId: ' '), ' ambient ')['visitor_id']);
        self::assertArrayNotHasKey('visitor_id', $this->build('user_login', new EventInput(email: 'a@example.test'), " \t"));
        self::assertArrayNotHasKey('properties', $this->build('user_login', new EventInput(email: 'a@example.test')));
    }

    public function testRejectsBlankEventKeyAndMissingIdentity(): void
    {
        $this->assertInvalid('event key', fn() => $this->build(" \t", new EventInput(email: 'a@example.test')));
        $this->assertInvalid('email or phone number', fn() => $this->build('user_login', new EventInput(email: ' ', phoneNumber: "\n", contactName: 'Ada')));
        self::assertSame('+62', $this->build('user_login', new EventInput(phoneNumber: '+62'))['phone_number']);
    }

    public function testEventIdAndOccurredAt(): void
    {
        $explicit = $this->build('order_paid', new EventInput(
            email: 'a@example.test',
            eventId: ' order-1 ',
            occurredAt: new \DateTimeImmutable('2026-09-13T08:15:30.250999+07:00'),
        ));
        self::assertSame('order-1', $explicit['event_id']);
        self::assertSame('2026-09-13T01:15:30.250Z', $explicit['occurred_at']);

        $before = new \DateTimeImmutable();
        /** @var array<string, string> $generated */
        $generated = json_decode((new PayloadBuilder())->build('order_paid', true, new EventInput(email: 'a@example.test', eventId: ' '), null), true, 512, JSON_THROW_ON_ERROR);
        /** @var array<string, string> $second */
        $second = json_decode((new PayloadBuilder())->build('order_paid', true, new EventInput(email: 'a@example.test'), null), true, 512, JSON_THROW_ON_ERROR);
        self::assertMatchesRegularExpression(self::UUID_V4, $generated['event_id']);
        self::assertNotSame($generated['event_id'], $second['event_id']);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $generated['occurred_at']);
        $occurredAt = new \DateTimeImmutable($generated['occurred_at']);
        self::assertGreaterThanOrEqual($before->getTimestamp() - 1, $occurredAt->getTimestamp());
        self::assertLessThanOrEqual(time() + 1, $occurredAt->getTimestamp());

        $this->assertInvalid('occurredAt', fn() => $this->build('order_paid', new EventInput(email: 'a@example.test', occurredAt: (new \DateTimeImmutable('@0'))->setDate(10000, 1, 1))));
    }

    public function testTopLevelPropertiesAlwaysEncodeAsObjects(): void
    {
        self::assertSame('{}', $this->propertiesJson([]));
        self::assertSame('{}', $this->propertiesJson(new \stdClass()));
        self::assertSame('{"a":1,"list":[],"empty":{}}', $this->propertiesJson(['a' => 1, 'list' => [], 'empty' => new \stdClass()]));
        $this->assertInvalid('must be an object', fn() => $this->build('user_login', new EventInput(email: 'a@example.test', properties: ['value'])));
    }

    public function testAcceptsJsonSerializableAndNormalizesSafeNumbers(): void
    {
        $serializable = new class implements \JsonSerializable {
            public function jsonSerialize(): mixed
            {
                return ['sku' => 'A-1', 'quantity' => 2];
            }
        };
        self::assertSame(
            '{"item":{"sku":"A-1","quantity":2},"max":9007199254740991,"min":-9007199254740991,"decimal":1.5,"float":2.0}',
            $this->propertiesJson(['item' => $serializable, 'max' => 9007199254740991, 'min' => -9007199254740991, 'decimal' => 1.5, 'float' => 2.0]),
        );
    }

    /**
     * @return iterable<string, array{mixed, string}>
     */
    public static function invalidProperties(): iterable
    {
        yield 'NaN' => [['risk' => NAN], 'properties.risk'];
        yield 'positive infinity' => [['risk' => INF], 'properties.risk'];
        yield 'negative infinity' => [['risk' => -INF], 'properties.risk'];
        yield 'unsafe high integer' => [['id' => 9007199254740992], 'properties.id'];
        yield 'unsafe low integer' => [['id' => -9007199254740992], 'properties.id'];
        yield 'unsafe integral float' => [['id' => 9007199254740992.0], 'properties.id'];
        yield 'nested unsafe integer' => [['order' => ['items' => [1, PHP_INT_MAX]]], 'properties.order.items[1]'];
        yield 'integer key' => [['map' => [5 => 'five']], 'integer key'];
        yield 'arbitrary object' => [['when' => new \DateTimeImmutable()], 'properties.when'];
        yield 'closure' => [['fn' => static fn() => null], 'properties.fn'];
        yield 'invalid UTF-8' => [['text' => "\xB1\x31"], 'UTF-8'];
    }

    #[DataProvider('invalidProperties')]
    public function testRejectsNonPortableProperties(mixed $properties, string $message): void
    {
        /** @var array<array-key, mixed> $properties */
        $this->assertInvalid($message, fn() => $this->build('order_paid', new EventInput(email: 'a@example.test', properties: $properties)));
    }

    public function testRejectsResourcesAndCyclesButAcceptsRepeatedReferences(): void
    {
        $resource = fopen('php://memory', 'r');
        self::assertIsResource($resource);
        $this->assertInvalid('properties.stream', fn() => $this->build('order_paid', new EventInput(email: 'a@example.test', properties: ['stream' => $resource])));
        fclose($resource);

        $cycle = new \stdClass();
        $cycle->self = $cycle;
        $this->assertInvalid('cycle', fn() => $this->build('order_paid', new EventInput(email: 'a@example.test', properties: ['value' => $cycle])));

        $shared = new \stdClass();
        $shared->value = 'reused';
        self::assertSame('{"first":{"value":"reused"},"second":{"value":"reused"}}', $this->propertiesJson(['first' => $shared, 'second' => $shared]));
    }

    public function testOrderPaidPropertiesAreMergedWithoutMutatingInput(): void
    {
        $properties = new \stdClass();
        $properties->order_id = 'ord-1';
        $event = new EventInput(email: 'a@example.test', properties: $properties);
        $merged = PayloadBuilder::withOrderPaidProperties(125000, ' IDR ', $event);
        self::assertSame('{"order_id":"ord-1","amount":125000,"currency":" IDR "}', json_encode($merged->properties, JSON_THROW_ON_ERROR));
        self::assertSame(['order_id' => 'ord-1'], get_object_vars($properties));

        $fromArray = PayloadBuilder::withOrderPaidProperties(12.5, 'USD', new EventInput(email: 'a@example.test', properties: ['order_id' => 'ord-2']));
        self::assertSame(['order_id' => 'ord-2', 'amount' => 12.5, 'currency' => 'USD'], $fromArray->properties);
        self::assertSame(['amount' => 1, 'currency' => 'USD'], PayloadBuilder::withOrderPaidProperties(1, 'USD', new EventInput(email: 'a@example.test'))->properties);
    }

    public function testOrderPaidRejectsInvalidArgumentsAndConflicts(): void
    {
        $event = new EventInput(email: 'a@example.test');
        $this->assertInvalid('amount', fn() => PayloadBuilder::withOrderPaidProperties(NAN, 'IDR', $event));
        $this->assertInvalid('amount', fn() => PayloadBuilder::withOrderPaidProperties(-INF, 'IDR', $event));
        $this->assertInvalid('currency', fn() => PayloadBuilder::withOrderPaidProperties(1, " \t", $event));
        $this->assertInvalid('"amount"', fn() => PayloadBuilder::withOrderPaidProperties(1, 'IDR', new EventInput(email: 'a@example.test', properties: ['amount' => 2])));
        $conflict = new \stdClass();
        $conflict->currency = 'USD';
        $this->assertInvalid('"currency"', fn() => PayloadBuilder::withOrderPaidProperties(1, 'IDR', new EventInput(email: 'a@example.test', properties: $conflict)));
        $this->assertInvalid('properties.amount', fn() => $this->build('order_paid', PayloadBuilder::withOrderPaidProperties(1e16, 'IDR', $event)));
    }

    /** @param array<array-key, mixed>|\stdClass $properties */
    private function propertiesJson(array|\stdClass $properties): string
    {
        $payload = $this->builder()->build('user_login', true, new EventInput(email: 'a@example.test', properties: $properties), null);
        /** @var \stdClass $decoded */
        $decoded = json_decode($payload, false, 512, JSON_THROW_ON_ERROR);

        return json_encode($decoded->properties, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION);
    }

    private function assertInvalid(string $message, callable $callback): void
    {
        try {
            $callback();
        } catch (ValidationException $error) {
            self::assertStringContainsString($message, $error->getMessage());
            self::assertStringNotContainsString('very-secret', $error->getMessage());

            return;
        }
        self::fail('Expected ValidationException mentioning ' . $message);
    }
}
