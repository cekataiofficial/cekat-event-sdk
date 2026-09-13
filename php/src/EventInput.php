<?php

declare(strict_types=1);

namespace Cekat\EventSdk;

/**
 * An identity-bearing event. At least one of email or phone number must be nonblank.
 *
 * Properties are null (omitted), a string-keyed array, or a stdClass, and always encode
 * as a JSON object. Nested values may be null, booleans, strings, finite numbers, lists,
 * string-keyed arrays, stdClass, or JsonSerializable values that produce those types.
 */
final readonly class EventInput
{
    /**
     * @param array<array-key, mixed>|\stdClass|null $properties
     * @param string|null $eventId Identifies this event so the server can deduplicate deliveries.
     *                             When blank, the SDK generates a random UUID and reuses it for every retry.
     * @param \DateTimeInterface|null $occurredAt When the event happened; defaults to the time of the call.
     */
    public function __construct(
        public ?string $email = null,
        public ?string $phoneNumber = null,
        public ?string $contactName = null,
        public ?string $visitorId = null,
        public array|\stdClass|null $properties = null,
        public ?string $eventId = null,
        public ?\DateTimeInterface $occurredAt = null,
    ) {}
}
