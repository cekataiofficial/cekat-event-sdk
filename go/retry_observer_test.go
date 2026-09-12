package cekat

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestRetryDelayObserverIsOptInAndContextScoped(t *testing.T) {
	if got := WithRetryDelayObserver(context.Background(), nil); got != context.Background() {
		t.Fatal("nil observer changed context")
	}
	var first, second []time.Duration
	firstContext := WithRetryDelayObserver(context.Background(), func(delay time.Duration) { first = append(first, delay) })
	secondContext := WithRetryDelayObserver(context.Background(), func(delay time.Duration) { second = append(second, delay) })
	observeRetryDelay(firstContext, 10*time.Millisecond)
	observeRetryDelay(secondContext, 20*time.Millisecond)
	observeRetryDelay(context.Background(), 30*time.Millisecond)
	if len(first) != 1 || first[0] != 10*time.Millisecond || len(second) != 1 || second[0] != 20*time.Millisecond {
		t.Fatalf("observers not context scoped: first=%v second=%v", first, second)
	}
}

func TestRetryDelayObserverConcurrentContextsAreIsolated(t *testing.T) {
	const calls = 100
	var first, second int
	var firstMu, secondMu sync.Mutex
	firstContext := WithRetryDelayObserver(context.Background(), func(time.Duration) { firstMu.Lock(); first++; firstMu.Unlock() })
	secondContext := WithRetryDelayObserver(context.Background(), func(time.Duration) { secondMu.Lock(); second++; secondMu.Unlock() })
	var wait sync.WaitGroup
	for range calls {
		wait.Add(2)
		go func() { defer wait.Done(); observeRetryDelay(firstContext, 0) }()
		go func() { defer wait.Done(); observeRetryDelay(secondContext, 0) }()
	}
	wait.Wait()
	if first != calls || second != calls {
		t.Fatalf("observer calls = (%d, %d), want (%d, %d)", first, second, calls, calls)
	}
}
