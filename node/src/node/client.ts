import { deliver, type DeliveryConfig, type DeliveryDependencies } from './delivery.js';
import { ValidationError } from './errors.js';
import type { Acknowledgement, CallOptions, ClientOptions, EventInput, FetchLike } from './types.js';
import { buildPayload, validateAccessToken } from './validation.js';
import { currentVisitorId } from './visitor-context.js';

const DEFAULT_ORIGIN = 'https://server.cekat.ai';
const INGEST_PATH = '/api/events/ingest';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_COUNT = 2;

interface NormalizedOptions {
  readonly delivery: DeliveryConfig;
  readonly dependencies: DeliveryDependencies;
}

/** Sends Cekat events to the configured ingest origin. */
export class Client {
  readonly #accessToken: string;
  readonly #options: NormalizedOptions;

  constructor(accessToken: string, options: ClientOptions = {}) {
    validateAccessToken(accessToken);
    this.#accessToken = accessToken;
    this.#options = normalizeOptions(this.#accessToken, options);
  }

  userRegistration(event: EventInput, options?: CallOptions): Promise<Acknowledgement> {
    return this.track('user_registration', true, event, options);
  }

  userLogin(event: EventInput, options?: CallOptions): Promise<Acknowledgement> {
    return this.track('user_login', true, event, options);
  }

  orderCreated(event: EventInput, options?: CallOptions): Promise<Acknowledgement> {
    return this.track('order_created', true, event, options);
  }

  orderPaid(event: EventInput, options?: CallOptions): Promise<Acknowledgement> {
    return this.track('order_paid', true, event, options);
  }

  customEvent(eventKey: string, event: EventInput, options?: CallOptions): Promise<Acknowledgement> {
    return this.track(eventKey, false, event, options);
  }

  private track(eventKey: string, isCommon: boolean, event: EventInput, options: CallOptions | undefined): Promise<Acknowledgement> {
    const payload = buildPayload(eventKey, isCommon, event, currentVisitorId());
    return deliver(this.#options.delivery, payload, options ?? {}, this.#options.dependencies);
  }
}

function normalizeOptions(accessToken: string, options: ClientOptions): NormalizedOptions {
  const origin = normalizeOrigin(options.baseURL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
  const fetch = options.fetch ?? globalThis.fetch;

  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ValidationError('timeoutMs must be a finite number greater than 0');
  }
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new ValidationError('retryCount must be a nonnegative integer');
  }
  if (typeof fetch !== 'function') {
    throw new ValidationError('fetch must be callable');
  }

  return {
    delivery: {
      url: `${origin}${INGEST_PATH}`,
      accessToken,
      timeoutMs,
      retryCount,
    },
    dependencies: {
      fetch,
      sleep: (milliseconds, signal) => sleep(milliseconds, signal),
      random: Math.random,
    },
  };
}

function normalizeOrigin(baseURL: string | undefined): string {
  const candidate = baseURL ?? DEFAULT_ORIGIN;
  if (typeof candidate !== 'string') {
    throw new ValidationError('baseURL must be an absolute HTTP(S) origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ValidationError('baseURL must be an absolute HTTP(S) origin');
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ValidationError('baseURL must be an absolute HTTP(S) origin');
  }
  return parsed.origin;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
