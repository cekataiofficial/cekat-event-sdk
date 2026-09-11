import { readdir, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  Client,
  EventDefinitionNotFoundError,
  ResponseDecodeError,
  TransportError,
  ValidationError,
  runWithVisitorFromHeaders,
  runWithVisitorId,
} from '../../src/node/index.js';

type Fixture = Record<string, any>;
const REQUIRED_ENV = ['CEKAT_CONFORMANCE_BASE_URL', 'CEKAT_CONFORMANCE_CONTROL_URL', 'CEKAT_CONFORMANCE_ACCESS_TOKEN', 'CEKAT_CONFORMANCE_FIXTURES'] as const;
const configured = REQUIRED_ENV.every((name) => process.env[name] !== undefined && process.env[name] !== '');
const baseURL = process.env.CEKAT_CONFORMANCE_BASE_URL ?? '';
const controlURL = process.env.CEKAT_CONFORMANCE_CONTROL_URL ?? '';
const token = process.env.CEKAT_CONFORMANCE_ACCESS_TOKEN ?? '';
const fixturesDirectory = process.env.CEKAT_CONFORMANCE_FIXTURES ?? '';

/** The runner's direct-fixture contract. It deliberately has no filename allowlist. */
async function discoverFixtures(directory: string): Promise<Fixture[]> {
  if (!isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error('CEKAT_CONFORMANCE_FIXTURES must be an absolute readable directory');
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && extname(entry.name) === '.json').map((entry) => entry.name).sort();
  if (files.length === 0) throw new Error('fixture corpus contains no direct JSON files');
  const ids = new Set<string>();
  return Promise.all(files.map(async (file) => {
    const value: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
    validateFixture(value, basename(file, '.json'));
    const fixture = value as Fixture;
    if (ids.has(fixture.id)) throw new Error(`duplicate fixture ID ${fixture.id}`);
    ids.add(fixture.id);
    return fixture;
  }));
}

function object(value: unknown, label: string): Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
function closed(value: unknown, label: string, allowed: readonly string[], required: readonly string[]): Record<string, any> {
  const result = object(value, label);
  for (const key of Object.keys(result)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
  for (const key of required) if (!(key in result)) throw new Error(`${label} is missing required field ${key}`);
  return result;
}
function oneOf(value: unknown, values: readonly string[], label: string): void {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`unknown ${label} ${String(value)}`);
}

/** Mirrors the closed shared schema plus runtime-only recipe vocabulary. */
function validateFixture(value: unknown, filenameID: string): void {
  const fixture = closed(value, 'fixture', ['schema_version', 'id', 'description', 'kind', 'applicability', 'client', 'inbound', 'operation', 'responses', 'response_body_recipe', 'cancellation', 'expect'], ['schema_version', 'id', 'description', 'kind', 'operation', 'expect']);
  if (fixture.schema_version !== 1) throw new Error(`unknown schema_version ${String(fixture.schema_version)}`);
  if (typeof fixture.id !== 'string' || fixture.id !== filenameID) throw new Error(`filename/ID mismatch ${String(fixture.id)}`);
  if (typeof fixture.description !== 'string' || fixture.description.length === 0) throw new Error('fixture description is required');
  oneOf(fixture.kind, ['request', 'validation', 'success', 'error', 'retry', 'cancellation'], 'kind');
  const operation = closed(fixture.operation, 'operation', ['name', 'event_key', 'event', 'properties_recipe'], ['name', 'event']);
  oneOf(operation.name, ['user_registration', 'user_login', 'order_created', 'order_paid', 'custom_event'], 'operation');
  closed(operation.event, 'operation.event', ['email', 'phone_number', 'contact_name', 'visitor_id', 'properties'], []);
  if (operation.properties_recipe !== undefined) {
    oneOf(operation.properties_recipe, ['nan', 'positive_infinity', 'negative_infinity', 'unsafe_integer_high', 'unsafe_integer_low', 'cycle', 'non_string_key', 'runtime_object'], 'properties recipe');
    if (operation.event.properties !== undefined) throw new Error('properties recipe cannot accompany literal properties');
  }
  if (fixture.client !== undefined) {
    const client = closed(fixture.client, 'client', ['timeout_ms', 'retry_count'], []);
    if (client.timeout_ms !== undefined && (!Number.isInteger(client.timeout_ms) || client.timeout_ms < 1)) throw new Error('invalid timeout_ms');
    if (client.retry_count !== undefined && (!Number.isInteger(client.retry_count) || client.retry_count < 0)) throw new Error('invalid retry_count');
  }
  if (fixture.inbound !== undefined) closed(fixture.inbound, 'inbound', ['header_visitor_id', 'cookie_visitor_id', 'ambient_visitor_id'], []);
  if (fixture.applicability !== undefined) {
    const applicability = closed(fixture.applicability, 'applicability', ['requires_capabilities', 'inapplicable_languages'], ['requires_capabilities', 'inapplicable_languages']);
    if (JSON.stringify(applicability.requires_capabilities) !== JSON.stringify(['caller_cancellation']) || JSON.stringify(applicability.inapplicable_languages) !== JSON.stringify(['php', 'ruby'])) throw new Error('unknown applicability declaration');
  }
  if (fixture.response_body_recipe !== undefined) {
    const recipe = closed(fixture.response_body_recipe, 'response_body_recipe', ['unit', 'minimum_utf8_bytes', 'suffix'], ['unit', 'minimum_utf8_bytes', 'suffix']);
    if (typeof recipe.unit !== 'string' || recipe.unit === '' || !Number.isInteger(recipe.minimum_utf8_bytes) || recipe.minimum_utf8_bytes < 65537 || typeof recipe.suffix !== 'string') throw new Error('unknown response-body recipe form');
  }
  if (fixture.cancellation !== undefined) oneOf(closed(fixture.cancellation, 'cancellation', ['phase'], ['phase']).phase, ['before_request', 'during_request', 'during_backoff'], 'cancellation phase');
  if (fixture.responses !== undefined) {
    if (!Array.isArray(fixture.responses)) throw new Error('responses must be an array');
    for (const response of fixture.responses) {
      const queued = closed(response, 'mock response', ['status', 'headers', 'body', 'delay_ms', 'disconnect_before_headers'], ['body']);
      const disconnect = queued.disconnect_before_headers === true;
      if (typeof queued.body !== 'string' || (disconnect ? queued.status !== undefined : !Number.isInteger(queued.status) || queued.status < 200 || queued.status > 599) || (queued.delay_ms !== undefined && (!Number.isInteger(queued.delay_ms) || queued.delay_ms < 0))) throw new Error('invalid mock-response form');
    }
  }
  const expected = closed(fixture.expect, 'expect', ['result', 'attempts', 'delivery_outcome_unknown', 'acknowledgement', 'status', 'error_message', 'server_error', 'server_code', 'retained_body_bytes', 'observed_body_bytes', 'body_truncated', 'request', 'jitter_bounds_ms'], ['result', 'attempts']);
  oneOf(expected.result, ['acknowledgement', 'validation_error', 'authentication_error', 'event_definition_not_found_error', 'api_error', 'transport_error', 'response_decode_error', 'caller_cancelled'], 'expect.result');
  if (!Number.isInteger(expected.attempts) || expected.attempts < 0) throw new Error('invalid expected attempts');
  if (['api_error', 'authentication_error', 'event_definition_not_found_error'].includes(expected.result) && (typeof expected.error_message !== 'string' || expected.error_message === '')) throw new Error('HTTP error result requires error_message');
  if (fixture.response_body_recipe !== undefined && (typeof expected.retained_body_bytes !== 'number' || typeof expected.observed_body_bytes !== 'number' || typeof expected.body_truncated !== 'boolean')) throw new Error('response recipe lacks body expectations');
}

function assertOrigin(value: string, name: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be an absolute pathless HTTP(S) origin`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(`${name} must be an absolute pathless HTTP(S) origin`);
}
async function control(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${controlURL}${path}`, init);
}
async function resetAndQueue(fixture: Fixture): Promise<void> {
  expect((await control('/__control/reset', { method: 'POST' })).status).toBe(204);
  const responses = (fixture.responses ?? []).map((response: any) => ({ ...response }));
  if (fixture.response_body_recipe !== undefined) {
    if (responses.length !== 1) throw new Error('response-body recipe requires exactly one response');
    responses[0].body = expandBodyRecipe(fixture.response_body_recipe);
  }
  expect((await control('/__control/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ responses }) })).status).toBe(204);
}
function expandBodyRecipe(recipe: any): string {
  let body = '';
  while (new TextEncoder().encode(body).byteLength < recipe.minimum_utf8_bytes) body += recipe.unit;
  return body + recipe.suffix;
}
function eventFor(fixture: Fixture): Record<string, any> {
  const event = { ...fixture.operation.event };
  if (fixture.operation.properties_recipe !== undefined) event.properties = propertiesFor(fixture.operation.properties_recipe);
  if ('phone_number' in event) { event.phoneNumber = event.phone_number; delete event.phone_number; }
  if ('contact_name' in event) { event.contactName = event.contact_name; delete event.contact_name; }
  if ('visitor_id' in event) { event.visitorId = event.visitor_id; delete event.visitor_id; }
  return event;
}
function propertiesFor(recipe: string): any {
  switch (recipe) {
    case 'nan': return { value: Number.NaN };
    case 'positive_infinity': return { value: Infinity };
    case 'negative_infinity': return { value: -Infinity };
    case 'unsafe_integer_high': return { value: Number.MAX_SAFE_INTEGER + 1 };
    case 'unsafe_integer_low': return { value: Number.MIN_SAFE_INTEGER - 1 };
    case 'cycle': { const value: any = {}; value.self = value; return value; }
    case 'non_string_key': return { [Symbol('not-a-string')]: 'value' };
    case 'runtime_object': return { value: new Date() };
    default: throw new Error(`unknown properties recipe ${recipe}`);
  }
}
function dispatch(client: Client, fixture: Fixture, signal?: AbortSignal) {
  const options = signal === undefined ? undefined : { signal };
  const event = eventFor(fixture);
  switch (fixture.operation.name) {
    case 'user_registration': return client.userRegistration(event, options);
    case 'user_login': return client.userLogin(event, options);
    case 'order_created': return client.orderCreated(event, options);
    case 'order_paid': return client.orderPaid(event, options);
    case 'custom_event': return client.customEvent(fixture.operation.event_key, event, options);
    default: throw new Error(`unknown operation ${fixture.operation.name}`);
  }
}
async function journal(): Promise<any[]> {
  const response = await control('/__control/requests');
  expect(response.status).toBe(200);
  const envelope: unknown = await response.json();
  const parsed = closed(envelope, 'request journal envelope', ['requests'], ['requests']);
  if (!Array.isArray(parsed.requests)) throw new Error('request journal envelope requests must be an array');
  return parsed.requests;
}
async function waitForJournal(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await journal()).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for mock journal');
}
function assertResult(fixture: Fixture, result: unknown, error: unknown): void {
  const expected = fixture.expect;
  expect(String(error ?? '')).not.toContain(token);
  if (expected.result === 'acknowledgement') {
    expect(error).toBeUndefined();
    if (expected.acknowledgement !== undefined) {
      expect(result).toMatchObject({ success: true, message: expected.acknowledgement.message, eventKey: expected.acknowledgement.event_key, validatedProperties: expected.acknowledgement.validated_properties });
    } else {
      expect(result).toMatchObject({ success: true });
    }
    return;
  }
  expect(error).toBeDefined();
  if (expected.result === 'validation_error') expect(error).toBeInstanceOf(ValidationError);
  else if (expected.result === 'authentication_error') expect(error).toBeInstanceOf(AuthenticationError);
  else if (expected.result === 'event_definition_not_found_error') expect(error).toBeInstanceOf(EventDefinitionNotFoundError);
  else if (expected.result === 'api_error') expect(error).toBeInstanceOf(ApiError);
  else if (expected.result === 'transport_error') expect(error).toBeInstanceOf(TransportError);
  else if (expected.result === 'response_decode_error') expect(error).toBeInstanceOf(ResponseDecodeError);
  else if (expected.result === 'caller_cancelled') expect(error).not.toBeInstanceOf(Error);
  if (expected.error_message !== undefined) expect((error as Error).message).toBe(expected.error_message);
  if (expected.result !== 'caller_cancelled' && expected.result !== 'validation_error') {
    expect((error as any).attempts).toBe(expected.attempts);
    expect((error as any).deliveryOutcomeUnknown).toBe(expected.delivery_outcome_unknown ?? false);
  }
  if (expected.retained_body_bytes !== undefined) {
    if (fixture.response_body_recipe !== undefined) {
      const bytes = new TextEncoder().encode(expandBodyRecipe(fixture.response_body_recipe));
      expect(bytes.byteLength).toBeGreaterThan(expected.retained_body_bytes);
      expect((error as any).rawBody).toBe(new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, expected.retained_body_bytes)));
    } else {
      expect(new TextEncoder().encode((error as any).rawBody).byteLength).toBe(expected.retained_body_bytes);
    }
  }
}
async function assertJournal(fixture: Fixture): Promise<void> {
  const entries = await journal();
  expect(entries).toHaveLength(fixture.expect.attempts);
  if (fixture.expect.request === undefined) return;
  for (const [index, entry] of entries.entries()) {
    expect(entry).toMatchObject({ sequence: index + 1, method: 'POST', path: fixture.expect.request.path });
    expect(entry.headers.authorization).toEqual([fixture.expect.request.authorization]);
    expect(JSON.parse(entry.body)).toEqual(fixture.expect.request.payload);
  }
}
async function execute(fixture: Fixture): Promise<void> {
  await resetAndQueue(fixture);
  const client = new Client(token, {
    baseURL,
    ...(fixture.client?.timeout_ms === undefined ? {} : { timeoutMs: fixture.client.timeout_ms }),
    ...(fixture.client?.retry_count === undefined ? {} : { retryCount: fixture.client.retry_count }),
  });
  const controller = fixture.cancellation === undefined ? undefined : new AbortController();
  if (fixture.cancellation?.phase === 'before_request') controller!.abort('caller cancelled');
  const invoke = async () => {
    if (fixture.cancellation?.phase === 'during_request') void waitForJournal().then(() => controller!.abort('caller cancelled'));
    if (fixture.cancellation?.phase === 'during_backoff') void waitForJournal().then(() => controller!.abort('caller cancelled'));
    return dispatch(client, fixture, controller?.signal);
  };
  let result: unknown;
  let error: unknown;
  const inbound = fixture.inbound;
  try {
    if (inbound?.header_visitor_id !== undefined || inbound?.cookie_visitor_id !== undefined) {
      result = await runWithVisitorFromHeaders({ 'x-cekat-visitor-id': inbound.header_visitor_id, cookie: inbound.cookie_visitor_id === undefined ? undefined : `_cekat_visitor_id=${inbound.cookie_visitor_id}` }, undefined, invoke);
    } else if (inbound?.ambient_visitor_id !== undefined) result = await runWithVisitorId(inbound.ambient_visitor_id, invoke);
    else result = await invoke();
  } catch (caught) { error = caught; }
  assertResult(fixture, result, error);
  await assertJournal(fixture);
}

describe.skipIf(!configured)('shared Node SDK conformance', () => {
  test('validates and executes every directly discovered fixture exactly once', async () => {
    assertOrigin(baseURL, 'CEKAT_CONFORMANCE_BASE_URL');
    assertOrigin(controlURL, 'CEKAT_CONFORMANCE_CONTROL_URL');
    const fixtures = await discoverFixtures(fixturesDirectory);
    const executed = new Set<string>();
    for (const fixture of fixtures) {
      await execute(fixture);
      if (executed.has(fixture.id)) throw new Error(`fixture ${fixture.id} executed more than once`);
      executed.add(fixture.id);
      process.stdout.write(`${JSON.stringify({ id: fixture.id, status: 'passed' })}\n`);
    }
    expect(executed).toEqual(new Set(fixtures.map((fixture) => fixture.id)));
  }, 30_000);
});
