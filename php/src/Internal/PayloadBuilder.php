<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Internal;

use Cekat\EventSdk\EventInput;
use Cekat\EventSdk\Exception\ValidationException;

/**
 * Validates event input and builds the JSON request body.
 *
 * @internal
 */
final class PayloadBuilder
{
    private const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
    private const MAX_DEPTH = 256;

    /**
     * @param \Closure(): \DateTimeImmutable|null $now
     * @param \Closure(): string|null $newEventId
     */
    public function __construct(
        private readonly ?\Closure $now = null,
        private readonly ?\Closure $newEventId = null,
    ) {}

    /**
     * @throws ValidationException
     */
    public function build(string $eventKey, bool $isCommon, EventInput $event, ?string $ambientVisitorId): string
    {
        if (trim($eventKey) === '') {
            throw new ValidationException('event key must not be blank');
        }
        if (trim($event->email ?? '') === '' && trim($event->phoneNumber ?? '') === '') {
            throw new ValidationException('event must include a nonblank email or phone number');
        }

        $eventId = self::trimToNull($event->eventId) ?? ($this->newEventId !== null ? ($this->newEventId)() : self::uuidV4());
        $payload = [
            'event_key' => $eventKey,
            'event_id' => $eventId,
            'occurred_at' => $this->occurredAt($event->occurredAt),
            'is_common' => $isCommon,
        ];
        if ($event->email !== null) {
            $payload['email'] = $event->email;
        }
        if ($event->phoneNumber !== null) {
            $payload['phone_number'] = $event->phoneNumber;
        }
        if ($event->contactName !== null) {
            $payload['contact_name'] = $event->contactName;
        }
        $visitorId = self::trimToNull($event->visitorId) ?? self::trimToNull($ambientVisitorId);
        if ($visitorId !== null) {
            $payload['visitor_id'] = $visitorId;
        }
        if ($event->properties !== null) {
            $payload['properties'] = self::normalizeObject($event->properties, 'properties', [], 0);
        }

        try {
            return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        } catch (\JsonException) {
            throw new ValidationException('event is not JSON-compatible; strings must be valid UTF-8');
        }
    }

    /**
     * Returns a copy of $event whose properties include the order_paid arguments.
     *
     * @throws ValidationException
     */
    public static function withOrderPaidProperties(int|float $amount, string $currency, EventInput $event): EventInput
    {
        if (is_float($amount) && !is_finite($amount)) {
            throw new ValidationException('amount must be a finite number');
        }
        if (trim($currency) === '') {
            throw new ValidationException('currency must not be blank');
        }
        $properties = $event->properties instanceof \stdClass ? clone $event->properties : ($event->properties ?? []);
        foreach (['amount', 'currency'] as $reserved) {
            if (is_array($properties) ? array_key_exists($reserved, $properties) : property_exists($properties, $reserved)) {
                throw new ValidationException(sprintf('properties must not contain "%s"; pass it as the orderPaid argument', $reserved));
            }
        }
        if (is_array($properties)) {
            $properties['amount'] = $amount;
            $properties['currency'] = $currency;
        } else {
            $properties->amount = $amount;
            $properties->currency = $currency;
        }

        return new EventInput(
            email: $event->email,
            phoneNumber: $event->phoneNumber,
            contactName: $event->contactName,
            visitorId: $event->visitorId,
            properties: $properties,
            eventId: $event->eventId,
            occurredAt: $event->occurredAt,
        );
    }

    /**
     * @param array<array-key, mixed>|\stdClass $value
     * @param array<int, true> $ancestors Object IDs on the current path.
     */
    private static function normalizeObject(array|\stdClass $value, string $path, array $ancestors, int $depth): \stdClass
    {
        if (is_array($value) && $value !== [] && array_is_list($value)) {
            throw new ValidationException($path . ' must be an object, not a list');
        }
        $normalized = self::normalizeValue($value, $path, $ancestors, $depth);

        // A top-level empty PHP array still means an empty JSON object.
        return $normalized instanceof \stdClass ? $normalized : new \stdClass();
    }

    /**
     * @param array<int, true> $ancestors Object IDs on the current path.
     */
    private static function normalizeValue(mixed $value, string $path, array $ancestors, int $depth): mixed
    {
        if ($depth > self::MAX_DEPTH) {
            throw new ValidationException($path . ' is nested too deeply or contains a cycle');
        }
        if ($value === null || is_bool($value) || is_string($value)) {
            return $value;
        }
        if (is_int($value)) {
            if ($value < -self::MAX_SAFE_INTEGER || $value > self::MAX_SAFE_INTEGER) {
                throw self::invalid($path);
            }

            return $value;
        }
        if (is_float($value)) {
            if (!is_finite($value) || ($value === floor($value) && abs($value) > self::MAX_SAFE_INTEGER)) {
                throw self::invalid($path);
            }

            return $value;
        }
        if (is_array($value)) {
            if (array_is_list($value)) {
                $list = [];
                foreach ($value as $index => $item) {
                    $list[] = self::normalizeValue($item, sprintf('%s[%d]', $path, $index), $ancestors, $depth + 1);
                }

                return $list;
            }
            $object = new \stdClass();
            foreach ($value as $key => $item) {
                if (!is_string($key)) {
                    throw new ValidationException(sprintf('%s has integer key %d; use array_values() for a list or a stdClass for an object', $path, $key));
                }
                $object->{$key} = self::normalizeValue($item, self::childPath($path, $key), $ancestors, $depth + 1);
            }

            return $object;
        }
        if ($value instanceof \stdClass || $value instanceof \JsonSerializable) {
            $id = spl_object_id($value);
            if (isset($ancestors[$id])) {
                throw new ValidationException($path . ' contains a cycle');
            }
            // $ancestors is passed by value, so siblings may repeat a reference without a false cycle.
            $ancestors[$id] = true;
            if ($value instanceof \JsonSerializable) {
                return self::normalizeValue($value->jsonSerialize(), $path, $ancestors, $depth + 1);
            }
            $object = new \stdClass();
            foreach (get_object_vars($value) as $key => $item) {
                $object->{$key} = self::normalizeValue($item, self::childPath($path, (string) $key), $ancestors, $depth + 1);
            }

            return $object;
        }

        throw self::invalid($path);
    }

    private function occurredAt(?\DateTimeInterface $occurredAt): string
    {
        $time = $occurredAt === null
            ? ($this->now !== null ? ($this->now)() : new \DateTimeImmutable())
            : \DateTimeImmutable::createFromInterface($occurredAt);
        $utc = $time->setTimezone(new \DateTimeZone('UTC'));
        $year = (int) $utc->format('Y');
        if ($year < 1 || $year > 9999) {
            throw new ValidationException('occurredAt must be between years 0001 and 9999');
        }

        return $utc->format('Y-m-d\TH:i:s.v\Z');
    }

    private static function uuidV4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0F) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3F) | 0x80);
        $hex = bin2hex($bytes);

        return sprintf('%s-%s-%s-%s-%s', substr($hex, 0, 8), substr($hex, 8, 4), substr($hex, 12, 4), substr($hex, 16, 4), substr($hex, 20));
    }

    private static function trimToNull(?string $value): ?string
    {
        $trimmed = trim($value ?? '');

        return $trimmed === '' ? null : $trimmed;
    }

    private static function childPath(string $parent, string $key): string
    {
        return $key === '' ? $parent . '[""]' : $parent . '.' . $key;
    }

    private static function invalid(string $path): ValidationException
    {
        return new ValidationException($path . ' is not a JSON-compatible value');
    }
}
