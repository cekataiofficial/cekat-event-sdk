import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/node/errors.js';
import { buildPayload, validateAccessToken } from '../../src/node/validation.js';

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
      is_common: isCommon,
      email: 'person@example.test',
    });
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

  it('rejects symbol keys, arrays with custom properties, and cycles without disclosing property values', () => {
    const symbolKeyed = { ordinary: 'value' } as Record<string | symbol, unknown>;
    symbolKeyed[Symbol('secret-key')] = 'property-value-must-not-leak';
    const arrayWithCustomProperty = ['value'] as unknown[] & { secret?: string };
    arrayWithCustomProperty.secret = 'property-value-must-not-leak';
    const mapCycle: Record<string, unknown> = {};
    mapCycle.self = mapCycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);

    for (const properties of [symbolKeyed, { arrayWithCustomProperty }, mapCycle, { arrayCycle }]) {
      const error = expectValidationError(() => buildPayload('order_paid', true, {
        email: 'ada@example.test',
        properties: properties as never,
      }));
      expect(error.message).toContain('properties');
      expect(error.message).not.toContain('property-value-must-not-leak');
    }
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
