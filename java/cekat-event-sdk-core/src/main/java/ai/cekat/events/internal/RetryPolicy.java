package ai.cekat.events.internal;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Locale;
import java.util.OptionalLong;
import java.util.Set;
import java.util.regex.Pattern;

/** Retry classification, jitter bounds, and Retry-After parsing. Not public API. */
public final class RetryPolicy {
    /** Longest server-requested pause the client waits for. */
    public static final long MAXIMUM_RETRY_AFTER_MILLIS = 5_000;

    private static final Set<Integer> RETRYABLE = Set.of(429, 500, 502, 503, 504);
    private static final Pattern DELTA_SECONDS = Pattern.compile("\\d+");
    private static final List<DateTimeFormatter> HTTP_DATES = List.of(
            DateTimeFormatter.ofPattern("EEE, dd MMM uuuu HH:mm:ss 'GMT'", Locale.US),
            DateTimeFormatter.ofPattern("EEEE, dd-MMM-uu HH:mm:ss 'GMT'", Locale.US),
            DateTimeFormatter.ofPattern("EEE MMM ppd HH:mm:ss uuuu", Locale.US));

    private RetryPolicy() {
    }

    /**
     * Reports whether a status is transient.
     *
     * @param status HTTP status
     * @return {@code true} for 429, 500, 502, 503, and 504
     */
    public static boolean isRetryableStatus(int status) {
        return RETRYABLE.contains(status);
    }

    /**
     * Returns the full-jitter upper bound before a one-indexed retry: 100ms doubling to a 1s cap.
     *
     * @param retry one-indexed retry number
     * @return inclusive upper bound in milliseconds
     */
    public static long delayBoundMillis(int retry) {
        int exponent = Math.min(Math.max(retry, 1), 5) - 1;
        return Math.min(100L << exponent, 1_000L);
    }

    /**
     * Parses a Retry-After value as delta-seconds or an HTTP-date.
     *
     * @param value header value, or {@code null}
     * @param now current time
     * @return the delay in milliseconds, or empty when absent or invalid
     */
    public static OptionalLong parseRetryAfterMillis(String value, Instant now) {
        if (value == null || value.isBlank()) {
            return OptionalLong.empty();
        }
        String trimmed = value.strip();
        if (DELTA_SECONDS.matcher(trimmed).matches()) {
            return OptionalLong.of(trimmed.length() > 9 ? Long.MAX_VALUE : Long.parseLong(trimmed) * 1_000);
        }
        for (DateTimeFormatter format : HTTP_DATES) {
            try {
                Instant date = LocalDateTime.parse(trimmed, format).toInstant(ZoneOffset.UTC);
                return OptionalLong.of(Math.max(0, Duration.between(now, date).toMillis()));
            } catch (DateTimeParseException ignored) {
                // Try the next permitted HTTP-date form.
            }
        }
        return OptionalLong.empty();
    }
}
