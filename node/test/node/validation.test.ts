import { describe, expect, it } from 'vitest';

import {
  ApiError,
  AuthenticationError,
  EventDefinitionNotFoundError,
  ResponseDecodeError,
  TransportError,
  ValidationError,
} from '../../src/node/errors.js';
import { buildPayload as buildPayloadWithClock, validateAccessToken } from '../../src/node/validation.js';

const fixedClock = { now: () => new Date('2026-09-13T01:15:30.250Z'), newEventId: () => 'generated-event-id' };
const buildPayload = (...args: [Parameters<typeof buildPayloadWithClock>[0], Parameters<typeof buildPayloadWithClock>[1], Parameters<typeof buildPayloadWithClock>[2], Parameters<typeof buildPayloadWithClock>[3]?]) =>
  buildPayloadWithClock(args[0], args[1], args[2], args[3], fixedClock);

describe('strict local validation', () => {
  it('rejects blank access tokens without disclosing them', () => {
    const token = 'secret-access-token';

    for (const value of ['', ' \t\n']) {
      const error = expectValidationError(() => validateAccessToken(value));
      expect(error.message).toContain('access token');
      expect(error.message).not.toContain(token);
    }
  });

  it('rejects blank event keys and events without an identity', () => {
    expect(expectValidationError(() => buildPayload(' \t', true, { email: 'ada@example.test' })).message)
      .toContain('event key');
    expect(expectValidationError(() => buildPayload('order_paid', true, {
      email: ' \n ',
      phoneNumber: '\t',
      contactName: 'Ada',
    })).message).toContain('email or phone number');
  });

  it('preserves identity/contact text while trimming explicit visitors and falling back to ambient visitors', () => {
    const payload = buildPayload(' custom_event ', false, {
      email: ' ada@example.test ',
      phoneNumber: ' +628123 ',
      contactName: ' Ada Lovelace ',
      visitorId: ' explicit-visitor\t ',
      properties: { nested: ['value', 12.5, null] },
    }, ' ambient-visitor ');

    expect(payload).toEqual({
      event_key: ' custom_event ',
      event_id: 'generated-event-id',
      occurred_at: '2026-09-13T01:15:30.250Z',
      is_common: false,
      email: ' ada@example.test ',
      phone_number: ' +628123 ',
      contact_name: ' Ada Lovelace ',
      visitor_id: 'explicit-visitor',
      properties: { nested: ['value', 12.5, null] },
    });

    expect(buildPayload('user_login', true, {
      email: 'fallback@example.test',
      visitorId: ' \t ',
    }, ' ambient-visitor ')).toMatchObject({ visitor_id: 'ambient-visitor' });
    expect(buildPayload('user_login', true, { email: 'none@example.test' }, ' \t ')).not.toHaveProperty('visitor_id');
  });

  it.each([
    ['user_registration', 'user_registration', true],
    ['user_login', 'user_login', true],
    ['order_created', 'order_created', true],
    ['order_paid', 'order_paid', true],
    ['custom_event', 'trial_started', false],
  ])('shapes %s payload exactly', (_name, eventKey, isCommon) => {
    expect(buildPayload(eventKey, isCommon, { email: 'person@example.test' })).toEqual({
      event_key: eventKey,
      event_id: 'generated-event-id',
      occurred_at: '2026-09-13T01:15:30.250Z',
      is_common: isCommon,
      email: 'person@example.test',
    });
  });

  it('trims caller event IDs, serializes caller timestamps as UTC milliseconds, and generates both otherwise', () => {
    expect(buildPayload('order_paid', true, {
      email: 'person@example.test',
      eventId: ' order-1 ',
      occurredAt: new Date('2026-09-13T08:15:30.250+07:00'),
    })).toMatchObject({ event_id: 'order-1', occurred_at: '2026-09-13T01:15:30.250Z' });
    expect(buildPayload('order_paid', true, { email: 'person@example.test', eventId: ' \t ' })).toMatchObject({ event_id: 'generated-event-id' });
    const generated = buildPayloadWithClock('order_paid', true, { email: 'person@example.test' });
    expect(generated.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const occurredAt of [new Date(Number.NaN), new Date('+010000-01-01T00:00:00Z'), '2026-09-13' as never]) {
      expect(expectValidationError(() => buildPayload('order_paid', true, { email: 'person@example.test', occurredAt })).message).toContain('occurredAt');
    }
  });

  it('accepts finite safe numbers and nested arrays/plain objects without mutating them', () => {
    const properties = {
      safeInteger: Number.MAX_SAFE_INTEGER,
      decimal: -12.5,
      nested: { values: [null, false, 'sku', -Number.MAX_SAFE_INTEGER] },
    };
    const payload = buildPayload('order_paid', true, { email: 'ada@example.test', properties });

    expect(payload.properties).toEqual(properties);
    expect(payload.properties).not.toBe(properties);
    expect(payload.properties?.nested).not.toBe(properties.nested);
  });

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['bigint', 1n],
    ['function', () => undefined],
    ['symbol', Symbol('secret-value')],
    ['date', new Date()],
    ['map', new Map([['key', 'value']])],
    ['set', new Set(['value'])],
    ['class instance', new (class RuntimeValue {})()],
    ['unsafe positive integer', Number.MAX_SAFE_INTEGER + 1],
    ['unsafe negative integer', Number.MIN_SAFE_INTEGER - 1],
  ])('rejects %s property values without disclosing their value', (_name, value) => {
    const secret = 'property-value-must-not-leak';
    const error = expectValidationError(() => buildPayload('order_paid', true, {
      email: 'ada@example.test',
      properties: { secret: value as never, secretValue: secret },
    }));

    expect(error.message).toContain('properties.secret');
    expect(error.message).not.toContain(secret);
  });

  it('accepts null-prototype property objects and ignores non-enumerable string and symbol values', () => {
    const properties = Object.create(null) as Record<string, unknown>;
    properties.visible = { nested: 'value' };
    Object.defineProperty(properties, 'hidden', { enumerable: false, value: 'ignored' });
    Object.defineProperty(properties, Symbol('hidden'), { enumerable: false, value: 'ignored' });

    expect(buildPayload('order_paid', true, {
      email: 'ada@example.test',
      properties: properties as never,
    }).properties).toEqual({ visible: { nested: 'value' } });
  });

  it('preserves own __proto__ JSON keys without mutating copied prototypes', () => {
    const parsed = JSON.parse('{"__proto__":{"parsed":true}}');
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nullPrototype, '__proto__', {
      enumerable: true,
      value: { nullPrototype: true },
    });

    for (const properties of [parsed, nullPrototype]) {
      const copied = buildPayload('order_paid', true, {
        email: 'ada@example.test',
        properties: properties as never,
      }).properties!;
      expect(Object.hasOwn(copied, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
      expect(copied.__proto__).toEqual(properties.__proto__);
    }
  });

  it('rejects enumerable accessors without invoking or disclosing them', () => {
    const secret = 'accessor-secret-must-not-leak';
    let changingReads = 0;
    const changing = {} as Record<string, unknown>;
    Object.defineProperty(changing, 'value', {
      enumerable: true,
      get: () => (changingReads++ === 0 ? 'initially valid' : new Date()),
    });
    let throwingReads = 0;
    const throwing = {} as Record<string, unknown>;
    Object.defineProperty(throwing, 'value', {
      enumerable: true,
      get: () => {
        throwingReads += 1;
        throw new Error(secret);
      },
    });

    for (const properties of [changing, throwing]) {
      const error = expectValidationError(() => buildPayload('order_paid', true, {
        email: 'ada@example.test',
        properties: properties as never,
      }));
      expect(error.message).toContain('properties.value');
      expect(error.message).not.toContain(secret);
    }
    expect(changingReads).toBe(0);
    expect(throwingReads).toBe(0);
  });

  it('rejects enumerable symbols, accessor arrays, sparse arrays, and custom array properties', () => {
    const symbolKeyed = { ordinary: 'value' } as Record<string | symbol, unknown>;
    symbolKeyed[Symbol('secret-key')] = 'property-value-must-not-leak';
    const nestedSymbol = { nested: {} as Record<string | symbol, unknown> };
    nestedSymbol.nested[Symbol('secret-key')] = 'property-value-must-not-leak';
    const arrayWithCustomProperty = ['value'] as unknown[] & { secret?: string };
    arrayWithCustomProperty.secret = 'property-value-must-not-leak';
    const sparseArray = ['value', , 'value'];
    const accessorArray = ['value'];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => { throw new Error('property-value-must-not-leak'); },
    });

    for (const properties of [symbolKeyed, nestedSymbol, { arrayWithCustomProperty }, { sparseArray }, { accessorArray }]) {
      const error = expectValidationError(() => buildPayload('order_paid', true, {
        email: 'ada@example.test',
        properties: properties as never,
      }));
      expect(error.message).toContain('properties');
      expect(error.message).not.toContain('property-value-must-not-leak');
    }
  });

  it('rejects direct and indirect cycles while accepting repeated references', () => {
    const direct: Record<string, unknown> = {};
    direct.self = direct;
    const indirect: Record<string, unknown> = { child: {} };
    (indirect.child as Record<string, unknown>).parent = indirect;
    const shared = { value: 'reused' };

    for (const properties of [direct, indirect]) {
      expect(expectValidationError(() => buildPayload('order_paid', true, {
        email: 'ada@example.test',
        properties: properties as never,
      })).message).toContain('contains a cycle');
    }
    expect(buildPayload('order_paid', true, {
      email: 'ada@example.test',
      properties: { first: shared, second: shared } as never,
    }).properties).toEqual({ first: shared, second: shared });
  });
});

describe('typed errors', () => {
  it('constructs ValidationError with its public name and message', () => {
    const error = new ValidationError('invalid event');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ValidationError');
    expect(error.message).toBe('invalid event');
  });

  it.each([
    [AuthenticationError, 'AuthenticationError', 401],
    [EventDefinitionNotFoundError, 'EventDefinitionNotFoundError', 404],
  ] as const)('constructs %s fields and only defines a supplied code', (ErrorType, name, status) => {
    const withCode = new ErrorType('request failed', { code: 'invalid_event', rawBody: 'body', attempts: 2 });
    const withoutCode = new ErrorType('request failed', { rawBody: 'body', attempts: 2 });

    expect(withCode).toMatchObject({ name, status, code: 'invalid_event', rawBody: 'body', attempts: 2, deliveryOutcomeUnknown: false });
    expect(Object.hasOwn(withoutCode, 'code')).toBe(false);
  });

  it('constructs ApiError fields and only defines a supplied code', () => {
    const withCode = new ApiError('request failed', 429, { code: 'rate_limited', rawBody: 'body', attempts: 3 });
    const withoutCode = new ApiError('request failed', 500, { rawBody: 'body', attempts: 1 });

    expect(withCode).toMatchObject({ name: 'ApiError', status: 429, code: 'rate_limited', rawBody: 'body', attempts: 3, deliveryOutcomeUnknown: false });
    expect(Object.hasOwn(withoutCode, 'code')).toBe(false);
  });

  it('constructs TransportError with its required cause and unknown delivery outcome', () => {
    const cause = new Error('socket closed');
    const error = new TransportError('request failed', 2, cause);

    expect(error).toMatchObject({ name: 'TransportError', attempts: 2, cause, deliveryOutcomeUnknown: true });
  });

  it('constructs ResponseDecodeError with optional cause semantics', () => {
    const cause = new SyntaxError('unexpected token');
    const withCause = new ResponseDecodeError('bad response', 'body', 1, cause);
    const withoutCause = new ResponseDecodeError('bad response', 'body', 1);

    expect(withCause).toMatchObject({ name: 'ResponseDecodeError', status: 200, rawBody: 'body', attempts: 1, cause, deliveryOutcomeUnknown: false });
    expect(Object.hasOwn(withoutCause, 'cause')).toBe(false);
  });
});

function expectValidationError(callback: () => unknown): ValidationError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('Expected ValidationError');
}
