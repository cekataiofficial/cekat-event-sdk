package cekat

import (
	"context"
	"time"
)

type retryDelayObserverKey struct{}

// WithRetryDelayObserver returns a context that calls observer with each retry
// delay selected by the client. It is intended for conformance instrumentation;
// nil observers leave the context unchanged. The observer is context-scoped, so
// concurrent clients cannot observe one another's retry delays.
func WithRetryDelayObserver(ctx context.Context, observer func(time.Duration)) context.Context {
	if observer == nil {
		return ctx
	}
	return context.WithValue(ctx, retryDelayObserverKey{}, observer)
}

func observeRetryDelay(ctx context.Context, delay time.Duration) {
	if observer, ok := ctx.Value(retryDelayObserverKey{}).(func(time.Duration)); ok {
		observer(delay)
	}
}
