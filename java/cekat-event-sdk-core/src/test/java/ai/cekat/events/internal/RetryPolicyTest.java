package ai.cekat.events.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Instant;
import java.util.List;
import java.util.OptionalLong;
import org.junit.jupiter.api.Test;

class RetryPolicyTest {
    @Test
    void classifiesStatusesAndCapsBounds() {
        List.of(429, 500, 502, 503, 504).forEach(status -> assertTrue(RetryPolicy.isRetryableStatus(status)));
        List.of(200, 400, 401, 404, 409, 422, 501).forEach(status -> assertFalse(RetryPolicy.isRetryableStatus(status)));
        assertEquals(List.of(100L, 200L, 400L, 800L, 1000L, 1000L, 1000L),
                List.of(1, 2, 3, 4, 5, 6, Integer.MAX_VALUE).stream().map(RetryPolicy::delayBoundMillis).toList());
    }

    @Test
    void parsesDeltaSecondsAndHttpDatesOnly() {
        Instant now = Instant.parse("2026-09-13T01:00:00Z");
        assertEquals(OptionalLong.empty(), RetryPolicy.parseRetryAfterMillis(null, now));
        assertEquals(OptionalLong.of(3000), RetryPolicy.parseRetryAfterMillis(" 3 ", now));
        assertEquals(OptionalLong.of(0), RetryPolicy.parseRetryAfterMillis("0", now));
        assertEquals(OptionalLong.of(Long.MAX_VALUE), RetryPolicy.parseRetryAfterMillis("99999999999999999999", now));
        assertEquals(OptionalLong.of(4000), RetryPolicy.parseRetryAfterMillis("Sun, 13 Sep 2026 01:00:04 GMT", now));
        assertEquals(OptionalLong.of(0), RetryPolicy.parseRetryAfterMillis("Sun, 13 Sep 2026 00:59:00 GMT", now));
        assertEquals(OptionalLong.of(5000), RetryPolicy.parseRetryAfterMillis("Sunday, 13-Sep-26 01:00:05 GMT", now));
        assertEquals(OptionalLong.of(6000), RetryPolicy.parseRetryAfterMillis("Sun Sep 13 01:00:06 2026", now));
        for (String invalid : List.of("-1", "1.5", "Sun 13 Sep 2026", "tomorrow", "")) {
            assertEquals(OptionalLong.empty(), RetryPolicy.parseRetryAfterMillis(invalid, now), invalid);
        }
    }
}
