import { describe, expect, it, vi } from 'vitest';

import { Client } from '../../src/node/client.js';
import { ValidationError } from '../../src/node/errors.js';
import { runWithVisitorId } from '../../src/node/visitor-context.js';
import type { FetchLike } from '../../src/node/types.js';

const acknowledgement = (eventKey: string) => JSON.stringify({
  success: true,
  data: {
    success: true,
    message: 'accepted',
    event_key: eventKey,
    validated_properties: ['email'],
  },
});

function successfulFetch(): FetchLike {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(init?.body as string) as { event_key: string };
    return new Response(acknowledgement(payload.event_key), { status: 200 });
  });
}

function validationError(callback: () => unknown): ValidationError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('Expected ValidationError');
}

describe('Client configuration', () => {
  it('constructs with only a nonblank token and uses the fixed default endpoint', async () => {
    const fetch = successfulFetch();
    const client = new Client('token-not-in-payload', { fetch });

    await expect(client.userLogin({ email: 'ada@example.test' })).resolves.toEqual({
      success: true,
      message: 'accepted',
      eventKey: 'user_login',
      validatedProperties: ['email'],
      rawBody: acknowledgement('user_login'),
    });
    expect(fetch).toHaveBeenCalledWith('https://server.cekat.ai/api/events/ingest', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer token-not-in-payload' }),
    }));

    expect(validationError(() => new Client(' \t '))).toHaveProperty('message', expect.not.stringContaining(' \t '));
  });

  it('accepts only absolute HTTP(S) origins and validates delivery options before use', () => {
    const fetch = successfulFetch();
    for (const baseURL of [
      'server.cekat.ai',
      'ftp://server.cekat.ai',
      'https://user:password@server.cekat.ai',
      'https://server.cekat.ai/events',
      'https://server.cekat.ai/?query=value',
      'https://server.cekat.ai/#fragment',
      'https://:443',
    ]) {
      expect(validationError(() => new Client('token', { baseURL, fetch })).message).toContain('baseURL');
    }
    expect(validationError(() => new Client('token', { timeoutMs: 0, fetch })).message).toContain('timeoutMs');
    expect(validationError(() => new Client('token', { timeoutMs: Number.NaN, fetch })).message).toContain('timeoutMs');
    expect(validationError(() => new Client('token', { timeoutMs: -1, fetch })).message).toContain('timeoutMs');
    expect(validationError(() => new Client('token', { timeoutMs: Number.POSITIVE_INFINITY, fetch })).message).toContain('timeoutMs');
    expect(validationError(() => new Client('token', { retryCount: -1, fetch })).message).toContain('retryCount');
    expect(validationError(() => new Client('token', { retryCount: 1.5, fetch })).message).toContain('retryCount');
    expect(validationError(() => new Client('token', { fetch: 'not callable' as never })).message).toContain('fetch');
  });

  it('normalizes a trailing slash from a custom origin before adding the fixed endpoint', async () => {
    const fetch = successfulFetch();
    const client = new Client('token', { baseURL: 'https://ingest.example/', fetch });

    await client.orderPaid({ email: 'ada@example.test' });
    expect(fetch).toHaveBeenCalledWith('https://ingest.example/api/events/ingest', expect.anything());
  });

  it('uses a 10-second timeout and two retries by default', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const attemptStartedAt: number[] = [];
      const attemptAbortedAt: number[] = [];
      const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        attemptStartedAt.push(Date.now());
        init?.signal?.addEventListener('abort', () => {
          attemptAbortedAt.push(Date.now());
          reject(init.signal?.reason);
        }, { once: true });
      }));
      const client = new Client('token', { fetch });
      const outcome = client.userLogin({ email: 'ada@example.test' });
      const assertion = expect(outcome).rejects.toMatchObject({ name: 'TransportError', attempts: 3 });

      expect(fetch).toHaveBeenCalledOnce();
      const firstAttemptStartedAt = attemptStartedAt[0];
      expect(firstAttemptStartedAt).toBeDefined();
      if (firstAttemptStartedAt === undefined) throw new Error('Expected first attempt start time');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetch).toHaveBeenCalledOnce();
      expect(attemptAbortedAt).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(attemptAbortedAt).toEqual([firstAttemptStartedAt + 10_000]);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      const secondAttemptStartedAt = attemptStartedAt[1];
      expect(secondAttemptStartedAt).toBeDefined();
      if (secondAttemptStartedAt === undefined) throw new Error('Expected second attempt start time');

      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(attemptAbortedAt).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attemptAbortedAt).toEqual([
        firstAttemptStartedAt + 10_000,
        secondAttemptStartedAt + 10_000,
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(3);
      const thirdAttemptStartedAt = attemptStartedAt[2];
      expect(thirdAttemptStartedAt).toBeDefined();
      if (thirdAttemptStartedAt === undefined) throw new Error('Expected third attempt start time');

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(attemptAbortedAt).toEqual([
        firstAttemptStartedAt + 10_000,
        secondAttemptStartedAt + 10_000,
        thirdAttemptStartedAt + 10_000,
      ]);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('Client event facade', () => {
  it('maps all five methods to their exact keys and common flags, without business_id', async () => {
    const fetch = successfulFetch();
    const client = new Client('token', { fetch });
    const event = { email: 'ada@example.test', properties: { order: 'A-1' } };

    const acknowledgements = await Promise.all([
      client.userRegistration(event),
      client.userLogin(event),
      client.orderCreated(event),
      client.orderPaid(event),
      client.customEvent('trial_started', event),
    ]);

    expect(acknowledgements).toEqual([
      expect.objectContaining({ success: true, eventKey: 'user_registration' }),
      expect.objectContaining({ success: true, eventKey: 'user_login' }),
      expect.objectContaining({ success: true, eventKey: 'order_created' }),
      expect.objectContaining({ success: true, eventKey: 'order_paid' }),
      expect.objectContaining({ success: true, eventKey: 'trial_started' }),
    ]);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string))).toEqual([
      { event_key: 'user_registration', is_common: true, email: 'ada@example.test', properties: { order: 'A-1' } },
      { event_key: 'user_login', is_common: true, email: 'ada@example.test', properties: { order: 'A-1' } },
      { event_key: 'order_created', is_common: true, email: 'ada@example.test', properties: { order: 'A-1' } },
      { event_key: 'order_paid', is_common: true, email: 'ada@example.test', properties: { order: 'A-1' } },
      { event_key: 'trial_started', is_common: false, email: 'ada@example.test', properties: { order: 'A-1' } },
    ]);
    for (const [, init] of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      expect(JSON.parse((init as RequestInit).body as string)).not.toHaveProperty('business_id');
    }
  });

  it('takes one payload snapshot at delivery time with explicit visitor precedence over ALS', async () => {
    const fetch = successfulFetch();
    const client = new Client('token', { fetch });
    const event = { email: 'ada@example.test', visitorId: ' explicit-visitor ', properties: { state: 'before' } };

    await runWithVisitorId('ambient-visitor', () => client.customEvent('trial_started', event));
    event.properties.state = 'after';
    await client.customEvent('outside_scope', { email: 'ada@example.test' });
    await runWithVisitorId('ambient-visitor', () => client.customEvent('ambient_event', {
      email: 'ada@example.test',
      visitorId: ' \t ',
    }));

    const payloads = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(payloads).toEqual([
      {
        event_key: 'trial_started',
        is_common: false,
        email: 'ada@example.test',
        visitor_id: 'explicit-visitor',
        properties: { state: 'before' },
      },
      { event_key: 'outside_scope', is_common: false, email: 'ada@example.test' },
      { event_key: 'ambient_event', is_common: false, email: 'ada@example.test', visitor_id: 'ambient-visitor' },
    ]);
  });
});
