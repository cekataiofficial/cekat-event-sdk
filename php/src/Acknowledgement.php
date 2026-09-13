<?php

declare(strict_types=1);

namespace Cekat\EventSdk;

/**
 * Cekat accepted the event for asynchronous processing. This does not confirm durable
 * storage, identity resolution, delivery completion, or analytics availability.
 */
final readonly class Acknowledgement
{
    /**
     * @param list<string> $validatedProperties
     */
    public function __construct(
        public bool $success,
        public string $message,
        public string $eventKey,
        public array $validatedProperties,
        public string $rawBody,
    ) {}
}
