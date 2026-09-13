import { randomUUID } from 'node:crypto';

import { ValidationError } from './errors.js';
import type { EventInput, JsonValue, WirePayload } from './types.js';

export function validateAccessToken(accessToken: string): void {
  if (accessToken.trim() === '') {
    throw new ValidationError('access token must not be blank');
  }
}

/** Supplies the event ID and call time; injectable so payload tests are deterministic. */
export interface PayloadClock {
  now: () => Date;
  newEventId: () => string;
}

const systemClock: PayloadClock = { now: () => new Date(), newEventId: randomUUID };

export function buildPayload(
  eventKey: string,
  isCommon: boolean,
  event: EventInput,
  ambientVisitorId?: string,
  clock: PayloadClock = systemClock,
): WirePayload {
  validateEvent(eventKey, event);

  const explicitVisitorId = normalizeVisitorId(event.visitorId);
  const visitorId = explicitVisitorId ?? normalizeVisitorId(ambientVisitorId);
  const payload: WirePayload = {
    event_key: eventKey,
    event_id: normalizeVisitorId(event.eventId) ?? clock.newEventId(),
    occurred_at: (event.occurredAt ?? clock.now()).toISOString(),
    is_common: isCommon,
  };

  if (event.email !== undefined) payload.email = event.email;
  if (event.phoneNumber !== undefined) payload.phone_number = event.phoneNumber;
  if (event.contactName !== undefined) payload.contact_name = event.contactName;
  if (visitorId !== undefined) payload.visitor_id = visitorId;
  if (event.properties !== undefined) payload.properties = copyJsonValue(event.properties, 'properties', new WeakSet<object>()) as Record<string, JsonValue>;

  return payload;
}

/**
 * Returns a copy of `event` whose properties include the required order_paid arguments.
 * Non-object events are returned unchanged so ordinary event validation reports them.
 */
export function withOrderPaidProperties(amount: number, currency: string, event: EventInput): EventInput {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ValidationError('amount must be a finite number');
  }
  if (typeof currency !== 'string' || currency.trim() === '') {
    throw new ValidationError('currency must not be blank');
  }
  if (typeof event !== 'object' || event === null) return event;
  const properties = event.properties;
  if (properties !== undefined && properties !== null && typeof properties === 'object') {
    for (const key of ['amount', 'currency']) {
      if (Object.hasOwn(properties, key)) {
        throw new ValidationError(`properties must not contain "${key}"; pass it as the orderPaid argument`);
      }
    }
  }
  return { ...event, properties: { ...properties, amount, currency } };
}

function validateEvent(eventKey: string, event: EventInput): void {
  if (typeof eventKey !== 'string' || eventKey.trim() === '') {
    throw new ValidationError('event key must not be blank');
  }
  if (typeof event !== 'object' || event === null) {
    throw new ValidationError('event must be an object');
  }
  for (const field of ['email', 'phoneNumber', 'contactName', 'visitorId', 'eventId'] as const) {
    if (event[field] !== undefined && typeof event[field] !== 'string') {
      throw new ValidationError(`${field} must be a string`);
    }
  }
  if (event.occurredAt !== undefined) {
    const year = event.occurredAt instanceof Date ? event.occurredAt.getUTCFullYear() : Number.NaN;
    if (!(year >= 1 && year <= 9999)) {
      throw new ValidationError('occurredAt must be a valid Date between years 0001 and 9999');
    }
  }
  if (event.email?.trim() === '' || event.email === undefined) {
    if (event.phoneNumber?.trim() === '' || event.phoneNumber === undefined) {
      throw new ValidationError('event must include a non-blank email or phone number');
    }
  }
}

function normalizeVisitorId(visitorId: string | undefined): string | undefined {
  if (visitorId === undefined) return undefined;
  const normalized = visitorId.trim();
  return normalized === '' ? undefined : normalized;
}

function copyJsonValue(value: unknown, path: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      invalidValue(path);
    }
    return value;
  }

  if (typeof value !== 'object') invalidValue(path);

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new ValidationError(`${path} contains a cycle`);
  }
  ancestors.add(objectValue);
  try {
    if (Object.getOwnPropertySymbols(objectValue).some((key) => Object.prototype.propertyIsEnumerable.call(objectValue, key))) {
      invalidValue(path);
    }

    if (Array.isArray(objectValue)) {
      for (const key of Object.keys(objectValue)) {
        if (!isArrayIndex(key, objectValue.length)) invalidValue(path);
      }
      const copied: JsonValue[] = [];
      for (let index = 0; index < objectValue.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          invalidValue(`${path}[${index}]`);
        }
        copied.push(copyJsonValue(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return copied;
    }

    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) invalidValue(path);

    const copied: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(objectValue)) {
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        invalidValue(propertyPath(path, key));
      }
      Object.defineProperty(copied, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: copyJsonValue(descriptor.value, propertyPath(path, key), ancestors),
      });
    }
    return copied;
  } finally {
    ancestors.delete(objectValue);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function invalidValue(path: string): never {
  throw new ValidationError(`${path} is not a JSON-compatible value`);
}

function propertyPath(parent: string, key: string): string {
  return key === '' ? `${parent}[""]` : `${parent}.${key}`;
}
