import { readBoundedBody } from './body.js';
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
}

export async function deliver(
  config: DeliveryConfig,
  payload: WirePayload,
  options: CallOptions,
  dependencies: DeliveryDependencies,
): Promise<Acknowledgement> {
  const maximumAttempts = config.retryCount + 1;
  for (let attempts = 1; attempts <= maximumAttempts; attempts += 1) {
    throwIfAborted(options.signal);
    let result: AttemptResult;
    try {
      result = await attempt(config, payload, options.signal, dependencies.fetch);
    } catch (error) {
      throwIfAborted(options.signal);
      if (attempts === maximumAttempts) {
        throw new TransportError('event delivery failed after transport failures', attempts, error);
      }
      await backoff(attempts, options.signal, dependencies);
      continue;
    }

    if (result.response.status !== 500) return classifyResponse(result.response, attempts);
    if (attempts === maximumAttempts) return classifyResponse(result.response, attempts);
    await backoff(attempts, options.signal, dependencies);
  }
  throw new Error('unreachable');
}

interface AttemptResult {
  response: Response;
}

async function attempt(config: DeliveryConfig, payload: WirePayload, callerSignal: AbortSignal | undefined, fetch: FetchLike): Promise<AttemptResult> {
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
    return { response };
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? createAbortError();
    // SDK timeouts and ordinary fetch failures are both retryable transport failures.
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortForCaller);
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

function classifyResponse(response: Response, attempts: number): Promise<Acknowledgement> {
  return readBoundedBody(response).then(({ rawBody, bodyTruncated }) => {
    if (response.status === 200) {
      if (bodyTruncated) {
        throw new ResponseDecodeError('response body exceeds 65536 bytes', rawBody, attempts);
      }
      try {
        const acknowledgement = parseAcknowledgement(rawBody);
        return acknowledgement;
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
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? createAbortError();
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}
