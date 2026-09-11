import { ValidationError } from './errors.js';
import type { EventInput, JsonValue, WirePayload } from './types.js';

export function validateAccessToken(accessToken: string): void {
  if (accessToken.trim() === '') {
    throw new ValidationError('access token must not be blank');
  }
}

export function buildPayload(
  eventKey: string,
  isCommon: boolean,
  event: EventInput,
  ambientVisitorId?: string,
): WirePayload {
  validateEvent(eventKey, event);

  const explicitVisitorId = normalizeVisitorId(event.visitorId);
  const visitorId = explicitVisitorId ?? normalizeVisitorId(ambientVisitorId);
  const payload: WirePayload = { event_key: eventKey, is_common: isCommon };

  if (event.email !== undefined) payload.email = event.email;
  if (event.phoneNumber !== undefined) payload.phone_number = event.phoneNumber;
  if (event.contactName !== undefined) payload.contact_name = event.contactName;
  if (visitorId !== undefined) payload.visitor_id = visitorId;
  if (event.properties !== undefined) payload.properties = copyJsonValue(event.properties, 'properties', new WeakSet<object>()) as Record<string, JsonValue>;

  return payload;
}

function validateEvent(eventKey: string, event: EventInput): void {
  if (eventKey.trim() === '') {
    throw new ValidationError('event key must not be blank');
  }
  if (event.email?.trim() === '' || event.email === undefined) {
    if (event.phoneNumber?.trim() === '' || event.phoneNumber === undefined) {
      throw new ValidationError('event must include a non-blank email or phone number');
    }
  }
  if (event.properties !== undefined) {
    validateJsonValue(event.properties, 'properties', new WeakSet<object>());
  }
}

function normalizeVisitorId(visitorId: string | undefined): string | undefined {
  if (visitorId === undefined) return undefined;
  const normalized = visitorId.trim();
  return normalized === '' ? undefined : normalized;
}

function validateJsonValue(value: unknown, path: string, ancestors: WeakSet<object>): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      invalidValue(path);
    }
    return;
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
      for (let index = 0; index < objectValue.length; index += 1) {
        validateJsonValue(objectValue[index], `${path}[${index}]`, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) invalidValue(path);
    for (const key of Object.keys(objectValue)) {
      validateJsonValue((objectValue as Record<string, unknown>)[key], propertyPath(path, key), ancestors);
    }
  } finally {
    ancestors.delete(objectValue);
  }
}

function copyJsonValue(value: JsonValue, path: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value;

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new ValidationError(`${path} contains a cycle`);
  }
  ancestors.add(objectValue);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => copyJsonValue(item, `${path}[${index}]`, ancestors));
    }
    const copied: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      copied[key] = copyJsonValue(value[key]!, propertyPath(path, key), ancestors);
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
