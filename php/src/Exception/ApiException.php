<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Exception;

/**
 * Cekat returned a non-200 response. The delivery outcome is known: the server responded.
 * AuthenticationException (401) and EventDefinitionNotFoundException (404) extend this class.
 */
class ApiException extends CekatException
{
    public readonly bool $deliveryOutcomeUnknown;

    /**
     * @param string $rawBody The first 65,536 bytes of the response body.
     */
    public function __construct(
        string $message,
        public readonly int $statusCode,
        public readonly ?string $serverCode,
        public readonly string $rawBody,
        public readonly int $attempts,
    ) {
        parent::__construct($message);
        $this->deliveryOutcomeUnknown = false;
    }
}
