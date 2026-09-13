package cekat

import (
	"context"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	initialRetryMaximum            = 100 * time.Millisecond
	maximumRetryMaximum            = time.Second
	maximumRetryAfter              = 5 * time.Second
	retryCountAttemptBoundsMessage = "retry count must be no greater than maximum int minus one so total attempts are representable"
)

// retryAttempts returns the total attempts for retryCount when representable
// in the public int attempt metadata.
func retryAttempts(retryCount int) (int, bool) {
	maxInt := int(^uint(0) >> 1)
	if retryCount < 0 || retryCount == maxInt {
		return 0, false
	}
	return retryCount + 1, true
}

// retryableStatus reports whether an HTTP status is transient.
func retryableStatus(status int) bool {
	switch status {
	case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

// parseRetryAfter parses a Retry-After header as delta-seconds or an HTTP-date.
// Past dates yield zero; invalid values report false.
func parseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	if strings.Trim(value, "0123456789") == "" {
		if len(value) > 9 {
			// Anything this large exceeds the retry cap; avoid duration overflow.
			return time.Duration(1<<63 - 1), true
		}
		seconds, err := strconv.Atoi(value)
		if err != nil {
			return 0, false
		}
		return time.Duration(seconds) * time.Second, true
	}
	date, err := http.ParseTime(value)
	if err != nil {
		return 0, false
	}
	if delay := date.Sub(now); delay > 0 {
		return delay, true
	}
	return 0, true
}

func defaultSleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// retryMaximum returns the capped exponential maximum for the given
// one-indexed retry. The cap prevents duration and shift overflow.
func retryMaximum(attempt int) time.Duration {
	if attempt <= 1 {
		return initialRetryMaximum
	}
	if attempt >= 5 {
		return maximumRetryMaximum
	}
	return initialRetryMaximum << (attempt - 1)
}

func fullJitter(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(max) + 1))
}
