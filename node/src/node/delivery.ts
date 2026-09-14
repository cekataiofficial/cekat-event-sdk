import { readBoundedBody, type BoundedBody } from './body.js';
import {
  ApiError,
  AuthenticationError,
  EventDefinitionNotFoundError,
  ResponseDecodeError,
  TransportError,
} from './errors.js';
import type { Acknowledgement, CallOptions, FetchLike, WirePayload } from './types.js';
import { runtimeProductToken } from './runtime.js';
import { SDK_VERSION } from './version.js';

export interface DeliveryConfig {
  url: string;
  accessToken: string;
  timeoutMs: number;
  retryCount: number;
}

export interface DeliveryDependencies {
  fetch: FetchLike;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  /** Internal/test instrumentation invoked after a final response body is consumed. */
  observeBody?: (body: BoundedBody) => void;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAXIMUM_RETRY_AFTER_MS = 5_000;
const USER_AGENT = `cekat-event-sdk-node/${SDK_VERSION} ${runtimeProductToken()}`;

/** A retryable response that should be retried after at least `retryAfterMs`. */
interface RetryResponse {
  readonly retry: true;
  readonly retryAfterMs: number | undefined;
}

export async function deliver(
  config: DeliveryConfig,
  payload: WirePayload,
  options: CallOptions,
  dependencies: DeliveryDependencies,
): Promise<Acknowledgement> {
  // Serialize once so every retry carries the same event ID and timestamp.
  const body = JSON.stringify(payload);
  const maximumAttempts = config.retryCount + 1;
  for (let attempts = 1; attempts <= maximumAttempts; attempts += 1) {
    throwIfAborted(options.signal);
    let retryAfterMs: number | undefined;
    try {
      const result = await attempt(config, body, options.signal, dependencies.fetch, async (response, signal) => {
        if (RETRYABLE_STATUSES.has(response.status) && attempts !== maximumAttempts) {
          const requested = parseRetryAfterMs(response.headers.get('retry-after'), Date.now());
          if (requested === undefined || requested <= MAXIMUM_RETRY_AFTER_MS) {
            await cancelBody(response);
            return { retry: true, retryAfterMs: requested } satisfies RetryResponse;
          }
          // The server asked for a longer pause than a caller should wait: report it now.
        }
        return classifyResponse(response, attempts, signal, dependencies.observeBody);
      });
      if (!isRetryResponse(result)) return result;
      retryAfterMs = result.retryAfterMs;
    } catch (error) {
      throwIfAborted(options.signal);
      if (isKnownOutcomeError(error)) throw error;
      if (attempts === maximumAttempts) {
        throw new TransportError('event delivery failed after transport failures', attempts, redactTransportCause(error, config.accessToken));
      }
    }
    await backoff(attempts, retryAfterMs, options.signal, dependencies);
  }
  throw new Error('unreachable');
}

function isRetryResponse(value: Acknowledgement | RetryResponse): value is RetryResponse {
  return 'retry' in value;
}

async function attempt<T>(
  config: DeliveryConfig,
  body: string,
  callerSignal: AbortSignal | undefined,
  fetch: FetchLike,
  consumeResponse: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortForCaller = () => controller.abort(callerSignal?.reason ?? createAbortError());
  if (callerSignal?.aborted) abortForCaller();
  else callerSignal?.addEventListener('abort', abortForCaller, { once: true });
  const timer = setTimeout(() => controller.abort(createAbortError()), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body,
      signal: controller.signal,
    });
    throwIfAborted(callerSignal);
    return await consumeResponse(response, controller.signal);
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? createAbortError();
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortForCaller);
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // This is best-effort resource cleanup before a retry.
  }
}

/** Full-jitter delay bound before one-indexed retry `retryNumber`: 100ms doubling to a 1s cap. */
export function retryDelayBoundMs(retryNumber: number): number {
  return Math.min(100 * 2 ** Math.min(Math.max(retryNumber, 1) - 1, 4), 1_000);
}

async function backoff(
  retryNumber: number,
  retryAfterMs: number | undefined,
  signal: AbortSignal | undefined,
  dependencies: DeliveryDependencies,
): Promise<void> {
  throwIfAborted(signal);
  const bound = retryDelayBoundMs(retryNumber);
  const jitter = Math.floor(dependencies.random() * (bound + 1));
  const milliseconds = Math.max(jitter, retryAfterMs ?? 0);
  await abortableSleep(milliseconds, signal, dependencies.sleep);
  throwIfAborted(signal);
}

const HTTP_DATE = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;

/** Parses Retry-After delta-seconds or an HTTP-date; invalid values return undefined. */
export function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return trimmed.length > 9 ? Number.POSITIVE_INFINITY : Number(trimmed) * 1_000;
  if (!HTTP_DATE.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function abortableSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleep: DeliveryDependencies['sleep'],
): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) return sleep(milliseconds);
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? createAbortError());
    signal.addEventListener('abort', abort, { once: true });
    void sleep(milliseconds, signal).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

async function classifyResponse(
  response: Response,
  attempts: number,
  signal: AbortSignal,
  observeBody: DeliveryDependencies['observeBody'],
): Promise<Acknowledgement> {
  let body: BoundedBody;
  try {
    body = await readBoundedBody(response, signal);
  } catch (error) {
    // A received status is a known outcome even when its body cannot be read. A 200
    // means the event was accepted, so it must not be retried as a transport failure.
    if (response.status === 200) throw new ResponseDecodeError('response body could not be read', '', attempts, error);
    body = { rawBody: '', bodyTruncated: false, observedBodyBytes: 0 };
  }
  observeBody?.(body);
  const { rawBody, bodyTruncated } = body;
  if (response.status === 200) {
    if (bodyTruncated) throw new ResponseDecodeError('response body exceeds 65536 bytes', rawBody, attempts);
    try {
      return parseAcknowledgement(rawBody);
    } catch (error) {
      if (error instanceof ResponseDecodeError) throw error;
      throw new ResponseDecodeError('response body is not a valid success envelope', rawBody, attempts, error);
    }
  }

  const parsed = parseApiError(rawBody);
  const message = parsed?.message ?? (response.statusText || STATUS_TEXT[response.status] || `HTTP ${response.status}`);
  const options = { rawBody, attempts, ...(parsed?.code === undefined ? {} : { code: parsed.code }) };
  if (response.status === 401) throw new AuthenticationError(message, options);
  if (response.status === 404) throw new EventDefinitionNotFoundError(message, options);
  throw new ApiError(message, response.status, options);
}

/** Reason phrases for statuses whose text a transport may omit (for example HTTP/2). */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  413: 'Payload Too Large', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function parseAcknowledgement(rawBody: string): Acknowledgement {
  const value: unknown = JSON.parse(rawBody);
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) throw new Error('invalid success envelope');
  const data = value.data;
  if (
    data.success !== true ||
    typeof data.message !== 'string' || data.message.length === 0 ||
    typeof data.event_key !== 'string' || data.event_key.length === 0 ||
    !Array.isArray(data.validated_properties) || !data.validated_properties.every((property) => typeof property === 'string')
  ) throw new Error('invalid success envelope');
  return {
    success: true,
    message: data.message,
    eventKey: data.event_key,
    validatedProperties: data.validated_properties,
    rawBody,
  };
}

function parseApiError(rawBody: string): { message: string; code?: string } | undefined {
  try {
    const value: unknown = JSON.parse(rawBody);
    if (!isRecord(value) || value.success !== false || typeof value.error !== 'string' || value.error.length === 0) return undefined;
    if (value.code !== undefined && typeof value.code !== 'string') return undefined;
    return value.code === undefined ? { message: value.error } : { message: value.error, code: value.code };
  } catch {
    return undefined;
  }
}

function redactTransportCause(cause: unknown, token: string, seen = new WeakSet<object>()): unknown {
  const redact = (value: string) => value.split(token).join('[REDACTED]');
  if (cause instanceof Error) {
    if (seen.has(cause)) return new Error('[circular transport cause]');
    seen.add(cause);
    const nested = redactTransportCause(cause.cause, token, seen);
    const safe = new Error(redact(cause.message), cause.cause === undefined ? undefined : { cause: nested });
    safe.name = redact(cause.name);
    return safe;
  }
  if (typeof cause === 'string') return redact(cause);
  if (cause !== null && typeof cause === 'object') {
    if (seen.has(cause)) return '[circular transport cause]';
    seen.add(cause);
    return redact(String(cause));
  }
  return cause;
}

function isKnownOutcomeError(error: unknown): boolean {
  return error instanceof ApiError ||
    error instanceof AuthenticationError ||
    error instanceof EventDefinitionNotFoundError ||
    error instanceof ResponseDecodeError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? createAbortError();
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}
