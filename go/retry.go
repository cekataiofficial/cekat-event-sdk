package cekat

import (
	"context"
	"math/rand/v2"
	"time"
)

const (
	initialRetryMaximum            = 100 * time.Millisecond
	maximumRetryMaximum            = time.Second
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
