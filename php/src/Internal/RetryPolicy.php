<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Internal;

/**
 * @internal
 */
final class RetryPolicy
{
    public const MAXIMUM_RETRY_AFTER_MS = 5_000;

    private const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
    private const HTTP_DATE = '/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/';

    public static function isRetryableStatus(int $status): bool
    {
        return in_array($status, self::RETRYABLE_STATUSES, true);
    }

    /** Full-jitter upper bound before one-indexed retry $retry: 100ms doubling to a 1s cap. */
    public static function delayBoundMilliseconds(int $retry): int
    {
        return min(100 * 2 ** (min(max($retry, 1), 5) - 1), 1_000);
    }

    /**
     * Parses Retry-After delta-seconds or an HTTP-date. Returns null when absent or invalid.
     */
    public static function parseRetryAfterMilliseconds(?string $value, int $nowMilliseconds): ?int
    {
        $trimmed = trim($value ?? '');
        if ($trimmed === '') {
            return null;
        }
        if (ctype_digit($trimmed)) {
            return strlen($trimmed) > 9 ? PHP_INT_MAX : (int) $trimmed * 1_000;
        }
        if (preg_match(self::HTTP_DATE, $trimmed) !== 1) {
            return null;
        }
        $timestamp = strtotime($trimmed);
        if ($timestamp === false) {
            return null;
        }

        return max(0, $timestamp * 1_000 - $nowMilliseconds);
    }
}
