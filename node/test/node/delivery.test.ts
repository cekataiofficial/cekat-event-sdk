import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  AuthenticationError,
  EventDefinitionNotFoundError,
  ResponseDecodeError,
  TransportError,
} from '../../src/node/errors.js';
import { deliver, type DeliveryConfig, type DeliveryDependencies } from '../../src/node/delivery.js';

const config: DeliveryConfig = {
  url: 'https://server.example/api/events/ingest',
  accessToken: 'token-that-must-not-leak',
  timeoutMs: 10_000,
  retryCount: 2,
};
const payload = { event_key: 'order_paid', is_common: true, email: 'ada@example.test' };
const success = JSON.stringify({
  success: true,
  data: { success: true, message: 'accepted', event_key: 'order_paid', validated_properties: ['order_id'] },
});

function dependencies(fetch: DeliveryDependencies['fetch'], overrides: Partial<DeliveryDependencies> = {}): DeliveryDependencies {
  return { fetch, sleep: vi.fn(async () => undefined), random: () => 0, ...overrides };
}

function response(status: number, body: string | Uint8Array | null, statusText = ''): Response {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const stream = bytes === null ? null : new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status, statusText });
}

function chunkedResponse(status: number, chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status });
}

async function rejected(callback: () => Promise<unknown>): Promise<unknown> {
  try {
    await callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection');
}

describe('deliver protocol and bounded bodies', () => {
  it('POSTs the exact JSON request and returns a strict acknowledgement', async () => {
    const fetch = vi.fn(async () => response(200, success));
    const ack = await deliver(config, payload, {}, dependencies(fetch));

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(config.url, expect.objectContaining({
      method: 'POST',
      headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }));
    expect(ack).toEqual({ success: true, message: 'accepted', eventKey: 'order_paid', validatedProperties: ['order_id'], rawBody: success });
  });

  it('accepts an exact 65,536-byte body at EOF, but detects byte 65,537 and retains exactly the prefix', async () => {
    const exact = new Uint8Array(65_536).fill(0x61);
    const oversized = new Uint8Array(65_537).fill(0x62);
    const exactError = await rejected(() => deliver(config, payload, {}, dependencies(async () => response(200, exact))));
    const oversizedError = await rejected(() => deliver(config, payload, {}, dependencies(async () => response(200, oversized))));

    expect(exactError).toBeInstanceOf(ResponseDecodeError);
    expect((exactError as ResponseDecodeError).rawBody).toHaveLength(65_536);
    expect((exactError as ResponseDecodeError).cause).toBeInstanceOf(Error);
    expect(oversizedError).toBeInstanceOf(ResponseDecodeError);
    expect((oversizedError as ResponseDecodeError).rawBody).toHaveLength(65_536);
    expect((oversizedError as ResponseDecodeError).cause).toBeUndefined();
  });

  it('uses replacement only when a retained truncation boundary splits UTF-8', async () => {
    const prefix = new Uint8Array(65_535).fill(0x61);
    const split = new Uint8Array([0xe2, 0x82]);
    const error = await rejected(() => deliver(config, payload, {}, dependencies(async () => chunkedResponse(200, [prefix, split]))));

    expect(error).toBeInstanceOf(ResponseDecodeError);
    expect((error as ResponseDecodeError).rawBody.endsWith('\uFFFD')).toBe(true);
  });

  it('cancels the reader after observing byte 65,537', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_536).fill(0x61));
        controller.enqueue(new Uint8Array([0x62]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await rejected(() => deliver(config, payload, {}, dependencies(async () => new Response(body, { status: 200 }))));

    expect(error).toBeInstanceOf(ResponseDecodeError);
    expect(cancelled).toBe(true);
  });

  it.each([
    '{}',
    JSON.stringify({ success: true, data: { success: false, message: 'ok', event_key: 'key', validated_properties: [] } }),
    JSON.stringify({ success: true, data: { success: true, message: '', event_key: 'key', validated_properties: [] } }),
    JSON.stringify({ success: true, data: { success: true, message: 'ok', event_key: 'key', validated_properties: ['ok', 2] } }),
  ])('rejects malformed 200 envelopes', async (body) => {
    const error = await rejected(() => deliver(config, payload, {}, dependencies(async () => response(200, body))));
    expect(error).toBeInstanceOf(ResponseDecodeError);
    expect((error as ResponseDecodeError).deliveryOutcomeUnknown).toBe(false);
  });

  it('maps conforming and malformed non-200 responses while retaining raw text', async () => {
    const conforming = JSON.stringify({ success: false, error: 'bad event', code: 'bad_event' });
    const cases: readonly [number, new (...args: never[]) => Error][] = [
      [400, ApiError as never], [401, AuthenticationError as never], [404, EventDefinitionNotFoundError as never], [429, ApiError as never],
    ];
    for (const [status, ErrorType] of cases) {
      const error = await rejected(() => deliver(config, payload, {}, dependencies(async () => response(status, conforming, 'Fallback'))));
      expect(error).toBeInstanceOf(ErrorType);
      expect(error).toMatchObject({ rawBody: conforming, attempts: 1, deliveryOutcomeUnknown: false });
      expect((error as Error & { message: string }).message).toBe('bad event');
    }
    const malformed = await rejected(() => deliver(config, payload, {}, dependencies(async () => response(400, '{oops', 'Bad Request'))));
    expect(malformed).toMatchObject({ name: 'ApiError', rawBody: '{oops', attempts: 1, deliveryOutcomeUnknown: false, message: 'Bad Request' });
  });
});

describe('deliver retry, timeout, redaction, and cancellation', () => {
  it('retries transport errors and exact 500 through attempt three with inclusive full jitter', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(response(500, JSON.stringify({ success: false, error: 'retry me' })))
      .mockResolvedValueOnce(response(200, success));
    const sleep = vi.fn(async () => undefined);
    await expect(deliver(config, payload, {}, dependencies(fetch, { sleep, random: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.999999) }))).resolves.toMatchObject({ eventKey: 'order_paid' });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 0);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it('does not retry received statuses other than exact 500', async () => {
    const fetch = vi.fn(async () => response(503, JSON.stringify({ success: false, error: 'unavailable' })));
    const sleep = vi.fn(async () => undefined);
    const error = await rejected(() => deliver(config, payload, {}, dependencies(fetch, { sleep })));
    expect(error).toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries each 10-second SDK timeout and returns an unknown-outcome TransportError without token leakage', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
      const outcome = rejected(() => deliver(config, payload, {}, dependencies(fetch)));
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({ attempts: 3, deliveryOutcomeUnknown: true });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect((error as Error).message).not.toContain(config.accessToken);
      expect(String((error as Error).cause)).not.toContain(config.accessToken);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts configured tokens from transport causes, including nested causes', async () => {
    const fetch = vi.fn(async () => Promise.reject(new Error(`outer ${config.accessToken}`, {
      cause: new Error(`inner ${config.accessToken}`),
    })));
    const error = await rejected(() => deliver(config, payload, {}, dependencies(fetch)));

    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).not.toContain(config.accessToken);
    expect(String((error as Error).cause)).not.toContain(config.accessToken);
    expect(String((error as Error & { cause: Error }).cause.cause)).not.toContain(config.accessToken);
  });

  it('retries stalled headers/body reads under the per-attempt SDK timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));
      const outcome = rejected(() => deliver(config, payload, {}, dependencies(fetch)));
      await vi.advanceTimersByTimeAsync(30_000);

      const error = await outcome;
      expect(error).toMatchObject({ name: 'TransportError', attempts: 3 });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves caller reason and does not retry when caller aborts after headers', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped after headers');
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));
    const outcome = deliver(config, payload, { signal: controller.signal }, dependencies(fetch));
    await Promise.resolve();
    controller.abort(reason);

    await expect(outcome).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('cancels intermediate retryable 500 bodies before retrying', async () => {
    let cancelled = false;
    const retryable = new Response(new ReadableStream<Uint8Array>({
      start() {},
      cancel() { cancelled = true; },
    }), { status: 500 });
    const fetch = vi.fn().mockResolvedValueOnce(retryable).mockResolvedValueOnce(response(200, success));

    await expect(deliver(config, payload, {}, dependencies(fetch))).resolves.toMatchObject({ eventKey: 'order_paid' });
    expect(cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('removes attempt timer and caller listener after successful response classification', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let attemptSignal: AbortSignal | undefined;
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        attemptSignal = init?.signal ?? undefined;
        return response(200, success);
      });
      await expect(deliver({ ...config, timeoutMs: 1 }, payload, { signal: controller.signal }, dependencies(fetch))).resolves.toMatchObject({ eventKey: 'order_paid' });
      controller.abort(new Error('late caller abort'));
      await vi.advanceTimersByTimeAsync(1);

      expect(attemptSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves caller reason in a timer race without starting a retry', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error('caller won timer race');
      setTimeout(() => controller.abort(reason), 10);
      const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));
      const outcome = deliver({ ...config, timeoutMs: 10 }, payload, { signal: controller.signal }, dependencies(fetch));
      const assertion = expect(outcome).rejects.toBe(reason);
      await vi.advanceTimersByTimeAsync(10);

      await assertion;
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does zero fetches for a pre-aborted caller signal and preserves its reason identity', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    controller.abort(reason);
    const fetch = vi.fn();
    await expect(deliver(config, payload, { signal: controller.signal }, dependencies(fetch))).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves caller cancellation during fetch, including a race with the SDK timer', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      controller.abort(reason);
    }));
    await expect(deliver({ ...config, timeoutMs: 1 }, payload, { signal: controller.signal }, dependencies(fetch))).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([1, 2])('interrupts backoff %i without starting another attempt', async (abortAfterSleep) => {
    const controller = new AbortController();
    const reason = new Error('stop during backoff');
    const fetch = vi.fn(async () => response(500, JSON.stringify({ success: false, error: 'retry' })));
    let calls = 0;
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      calls += 1;
      if (calls === abortAfterSleep) controller.abort(reason);
      if (signal?.aborted) throw signal.reason;
    });
    await expect(deliver(config, payload, { signal: controller.signal }, dependencies(fetch, { sleep }))).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(abortAfterSleep);
  });
});
