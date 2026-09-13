<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Internal;

/**
 * @internal
 */
final class HttpStatusText
{
    private const TEXT = [
        400 => 'Bad Request', 401 => 'Unauthorized', 403 => 'Forbidden', 404 => 'Not Found',
        405 => 'Method Not Allowed', 408 => 'Request Timeout', 409 => 'Conflict', 413 => 'Content Too Large',
        415 => 'Unsupported Media Type', 418 => "I'm a teapot", 422 => 'Unprocessable Content', 429 => 'Too Many Requests',
        500 => 'Internal Server Error', 501 => 'Not Implemented', 502 => 'Bad Gateway',
        503 => 'Service Unavailable', 504 => 'Gateway Timeout',
    ];

    public static function forStatus(int $status): string
    {
        return self::TEXT[$status] ?? 'HTTP ' . $status;
    }
}
