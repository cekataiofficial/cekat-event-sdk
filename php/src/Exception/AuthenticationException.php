<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Exception;

/**
 * Cekat rejected the access token (HTTP 401).
 */
final class AuthenticationException extends ApiException {}
