// Package retryobserver lets SDK instrumentation observe selected retry delays
// without adding a public client option.
package retryobserver

import (
	"context"
	"time"
)

type observerKey struct{}

// With returns a context that calls observer with each retry delay selected by
// the client. Nil observers leave the context unchanged. The observer is
// context-scoped, so concurrent clients cannot observe one another's delays.
func With(ctx context.Context, observer func(time.Duration)) context.Context {
	if observer == nil {
		return ctx
	}
	return context.WithValue(ctx, observerKey{}, observer)
}

// Observe reports delay to the observer installed in ctx, if any.
func Observe(ctx context.Context, delay time.Duration) {
	if observer, ok := ctx.Value(observerKey{}).(func(time.Duration)); ok {
		observer(delay)
	}
}
