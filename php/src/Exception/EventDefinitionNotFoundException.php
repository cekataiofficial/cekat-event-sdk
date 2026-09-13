<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Exception;

/**
 * The tenant has no definition for the submitted event key (HTTP 404).
 */
final class EventDefinitionNotFoundException extends ApiException {}
