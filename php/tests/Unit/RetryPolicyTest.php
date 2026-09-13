<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Unit;

use Cekat\EventSdk\Internal\RetryPolicy;
use PHPUnit\Framework\TestCase;

final class RetryPolicyTest extends TestCase
{
    public function testRetryableStatusesAndDelayBounds(): void
    {
        foreach ([429, 500, 502, 503, 504] as $status) {
            self::assertTrue(RetryPolicy::isRetryableStatus($status), (string) $status);
        }
        foreach ([200, 400, 401, 404, 409, 422, 501] as $status) {
            self::assertFalse(RetryPolicy::isRetryableStatus($status), (string) $status);
        }
        self::assertSame([100, 200, 400, 800, 1000, 1000, 1000], array_map(RetryPolicy::delayBoundMilliseconds(...), [1, 2, 3, 4, 5, 6, PHP_INT_MAX]));
    }

    public function testParsesRetryAfterSecondsAndHttpDatesOnly(): void
    {
        $now = (new \DateTimeImmutable('2026-09-13T01:00:00Z'))->getTimestamp() * 1000;
        self::assertNull(RetryPolicy::parseRetryAfterMilliseconds(null, $now));
        self::assertSame(3000, RetryPolicy::parseRetryAfterMilliseconds(' 3 ', $now));
        self::assertSame(0, RetryPolicy::parseRetryAfterMilliseconds('0', $now));
        self::assertSame(PHP_INT_MAX, RetryPolicy::parseRetryAfterMilliseconds('99999999999999999999', $now));
        self::assertSame(4000, RetryPolicy::parseRetryAfterMilliseconds('Sun, 13 Sep 2026 01:00:04 GMT', $now));
        self::assertSame(0, RetryPolicy::parseRetryAfterMilliseconds('Sun, 13 Sep 2026 00:59:00 GMT', $now));
        foreach (['-1', '1.5', 'Sun 13 Sep 2026', 'tomorrow', ''] as $invalid) {
            self::assertNull(RetryPolicy::parseRetryAfterMilliseconds($invalid, $now), $invalid);
        }
    }
}
