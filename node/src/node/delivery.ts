import { readBoundedBody, type BoundedBody } from './body.js';
import {
  ApiError,
  AuthenticationError,
  EventDefinitionNotFoundError,
  ResponseDecodeError,
  TransportError,
} from './errors.js';
import type { Acknowledgement, CallOptions, FetchLike, WirePayload } from './types.js';

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

const RETRY_RESPONSE = Symbol('retry response');

export async function deliver(
  config: DeliveryConfig,
  payload: WirePayload,
  options: CallOptions,
  dependencies: DeliveryDependencies,
): Promise<Acknowledgement> {
  const maximumAttempts = config.retryCount + 1;
  for (let attempts = 1; attempts <= maximumAttempts; attempts += 1) {
    throwIfAborted(options.signal);
    try {
      const result = await attempt(config, payload, options.signal, dependencies.fetch, async (response, signal) => {
        if (response.status === 500 && attempts !== maximumAttempts) {
          await cancelBody(response);
          return RETRY_RESPONSE;
        }
        return classifyResponse(response, attempts, signal, dependencies.observeBody);
      });
      if (result !== RETRY_RESPONSE) return result;
    } catch (error) {
      throwIfAborted(options.signal);
      if (isKnownOutcomeError(error)) throw error;
      if (attempts === maximumAttempts) {
        throw new TransportError('event delivery failed after transport failures', attempts, redactTransportCause(error, config.accessToken));
      }
    }
    await backoff(attempts, options.signal, dependencies);
  }
  throw new Error('unreachable');
}

async function attempt<T>(
  config: DeliveryConfig,
  payload: WirePayload,
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
      },
      body: JSON.stringify(payload),
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

async function backoff(retryNumber: number, signal: AbortSignal | undefined, dependencies: DeliveryDependencies): Promise<void> {
  throwIfAborted(signal);
  const bound = retryNumber === 1 ? 100 : 200;
  const milliseconds = Math.floor(dependencies.random() * (bound + 1));
  await abortableSleep(milliseconds, signal, dependencies.sleep);
  throwIfAborted(signal);
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
  const body = await readBoundedBody(response, signal);
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
  const message = parsed?.message ?? response.statusText;
  const options = { rawBody, attempts, ...(parsed?.code === undefined ? {} : { code: parsed.code }) };
  if (response.status === 401) throw new AuthenticationError(message, options);
  if (response.status === 404) throw new EventDefinitionNotFoundError(message, options);
  throw new ApiError(message, response.status, options);
}

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
