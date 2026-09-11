# Task 5 timing P2 repair report

## Scope

Changed only `node/test/node/client.test.ts`. No production or Task 6 files changed.

## Timing evidence

The default-delivery retry test uses a permanently stalled injected fetch and deterministic zero backoff (`Math.random() === 0`). It records the fake `Date.now()` at each attempt start and abort signal.

For attempts 1, 2, and 3, the test proves:

1. No new attempt begins during the first 9,999 ms.
2. Each attempt's abort signal fires exactly `10_000` ms after that attempt's recorded start time.
3. The client makes exactly three attempts and rejects with `TransportError` reporting `attempts: 3`.

Vitest 5 does not schedule this test's zero-delay retry after a current-time-only `advanceTimersByTimeAsync(0)`: the retry becomes observable after a deliberately controlled additional 1 ms. The test therefore does not claim that attempts 2 or 3 begin exactly at the timeout boundary. That additional 1 ms is used only to observe the zero-backoff retry after the exact abort-time assertion; it cannot traverse a future 10-second attempt timeout. The test contains no `runOnlyPendingTimersAsync` or unrestricted timer flush.

## Validation

From the repository worktree:

```text
npm exec vitest run test/node/client.test.ts  # passed: 1 file, 6 tests
cd node && npm run typecheck                 # not run successfully: tsc unavailable after dependencies were removed
```

`node_modules/` was an untracked transient Vitest cache directory and was removed before commit.
