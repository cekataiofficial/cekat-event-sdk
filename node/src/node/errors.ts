export class ValidationError extends Error {
  override readonly name = 'ValidationError';

  constructor(message: string) {
    super(message);
  }
}

interface ApiErrorOptions {
  code?: string;
  rawBody: string;
  attempts: number;
}

export class AuthenticationError extends Error {
  readonly status = 401 as const;
  readonly code?: string;
  readonly rawBody: string;
  readonly attempts: number;
  readonly deliveryOutcomeUnknown = false as const;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = 'AuthenticationError';
    if (options.code !== undefined) this.code = options.code;
    this.rawBody = options.rawBody;
    this.attempts = options.attempts;
  }
}

export class EventDefinitionNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code?: string;
  readonly rawBody: string;
  readonly attempts: number;
  readonly deliveryOutcomeUnknown = false as const;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = 'EventDefinitionNotFoundError';
    if (options.code !== undefined) this.code = options.code;
    this.rawBody = options.rawBody;
    this.attempts = options.attempts;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly rawBody: string;
  readonly attempts: number;
  readonly deliveryOutcomeUnknown = false as const;

  constructor(message: string, status: number, options: ApiErrorOptions) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (options.code !== undefined) this.code = options.code;
    this.rawBody = options.rawBody;
    this.attempts = options.attempts;
  }
}

export class TransportError extends Error {
  readonly attempts: number;
  readonly deliveryOutcomeUnknown = true as const;
  override readonly cause: unknown;

  constructor(message: string, attempts: number, cause: unknown) {
    super(message, { cause });
    this.name = 'TransportError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

export class ResponseDecodeError extends Error {
  readonly status = 200 as const;
  readonly rawBody: string;
  readonly attempts: number;
  readonly deliveryOutcomeUnknown = false as const;
  override readonly cause?: unknown;

  constructor(message: string, rawBody: string, attempts: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ResponseDecodeError';
    this.rawBody = rawBody;
    this.attempts = attempts;
    this.cause = cause;
  }
}
