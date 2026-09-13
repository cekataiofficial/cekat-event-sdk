import Ajv2020 from 'ajv/dist/2020.js';
import { readdir, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createClientForTesting, type Client } from '../../src/node/client.js';
import { ApiError, AuthenticationError, EventDefinitionNotFoundError, ResponseDecodeError, TransportError, ValidationError } from '../../src/node/errors.js';
import { runWithVisitorFromHeaders, runWithVisitorId } from '../../src/node/visitor-context.js';
import type { BoundedBody } from '../../src/node/body.js';

type Fixture = Record<string, any>;
type SchemaValidator = (value: unknown) => boolean;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaDirectory = join(root, 'conformance/fixtures/schemas');
const REQUIRED_ENV = ['CEKAT_CONFORMANCE_BASE_URL', 'CEKAT_CONFORMANCE_CONTROL_URL', 'CEKAT_CONFORMANCE_ACCESS_TOKEN', 'CEKAT_CONFORMANCE_FIXTURES'] as const;
const configured = REQUIRED_ENV.every((name) => process.env[name] !== undefined && process.env[name] !== '');
const baseURL = process.env.CEKAT_CONFORMANCE_BASE_URL ?? '';
const controlURL = process.env.CEKAT_CONFORMANCE_CONTROL_URL ?? '';
const token = process.env.CEKAT_CONFORMANCE_ACCESS_TOKEN ?? '';
const fixturesDirectory = process.env.CEKAT_CONFORMANCE_FIXTURES ?? '';

/** Loads every shared schema by its canonical $id, allowing only local, checked-in refs. */
async function loadSchemaValidator(schemaID: string, directory = schemaDirectory): Promise<SchemaValidator> {
  // The shared schema intentionally uses required within conditional branches,
  // which Ajv's strict lints reject despite valid Draft 2020-12 semantics.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, strictTuples: false });
  const names = [
    'json-value.schema.json', 'event-payload.schema.json', 'mock-response-queue.schema.json',
    'request-journal.schema.json', 'success-envelope.schema.json', 'error-envelope.schema.json',
    'conformance-case.schema.json',
  ];
  for (const name of names) ajv.addSchema(JSON.parse(await readFile(join(directory, name), 'utf8')));
  const validator = ajv.getSchema(schemaID);
  if (validator === undefined) throw new Error(`shared schema was not registered: ${schemaID}`);
  return (value) => {
    if (validator(value)) return true;
    throw new Error(`value violates shared JSON schema: ${ajv.errorsText(validator.errors, { separator: '; ' })}`);
  };
}

const journalValidator = loadSchemaValidator('https://schemas.cekat.ai/event-sdk/conformance/request-journal.schema.json');
async function loadFixtureValidator(directory = schemaDirectory): Promise<SchemaValidator> {
  return loadSchemaValidator('https://schemas.cekat.ai/event-sdk/conformance/conformance-case.schema.json', directory);
}

async function discoverFixtures(directory: string): Promise<Fixture[]> {
  if (!isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error('CEKAT_CONFORMANCE_FIXTURES must be an absolute readable directory');
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && extname(entry.name) === '.json').map((entry) => entry.name).sort();
  if (files.length === 0) throw new Error('fixture corpus contains no direct JSON files');
  const validate = await loadFixtureValidator(join(directory, '..', 'schemas'));
  const ids = new Set<string>();
  return Promise.all(files.map(async (file) => {
    const value: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
    validate(value);
    const fixture = value as Fixture;
    if (fixture.id !== basename(file, '.json')) throw new Error(`filename/ID mismatch ${String(fixture.id)}`);
    if (ids.has(fixture.id)) throw new Error(`duplicate fixture ID ${fixture.id}`);
    ids.add(fixture.id);
    return fixture;
  }));
}

function assertOrigin(value: string, name: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be an absolute pathless HTTP(S) origin`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(`${name} must be an absolute pathless HTTP(S) origin`);
}
async function control(path: string, init?: RequestInit): Promise<Response> { return fetch(`${controlURL}${path}`, init); }
function expandBodyRecipe(recipe: any): string {
  let body = '';
  while (new TextEncoder().encode(body).byteLength < recipe.minimum_utf8_bytes) body += recipe.unit;
  return body + recipe.suffix;
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
function eventFor(fixture: Fixture): Record<string, any> {
  const event = { ...fixture.operation.event };
  if (fixture.operation.properties_recipe !== undefined) event.properties = propertiesFor(fixture.operation.properties_recipe);
  if ('phone_number' in event) { event.phoneNumber = event.phone_number; delete event.phone_number; }
  if ('contact_name' in event) { event.contactName = event.contact_name; delete event.contact_name; }
  if ('visitor_id' in event) { event.visitorId = event.visitor_id; delete event.visitor_id; }
  if ('event_id' in event) { event.eventId = event.event_id; delete event.event_id; }
  if ('occurred_at' in event) { event.occurredAt = new Date(event.occurred_at); delete event.occurred_at; }
  return event;
}
function propertiesFor(recipe: string): any {
  switch (recipe) {
    case 'nan': return { value: Number.NaN }; case 'positive_infinity': return { value: Infinity }; case 'negative_infinity': return { value: -Infinity };
    case 'unsafe_integer_high': return { value: Number.MAX_SAFE_INTEGER + 1 }; case 'unsafe_integer_low': return { value: Number.MIN_SAFE_INTEGER - 1 };
    case 'cycle': { const value: any = {}; value.self = value; return value; }
    case 'non_string_key': return { [Symbol('not-a-string')]: 'value' }; case 'runtime_object': return { value: new Date() };
    default: throw new Error(`unknown properties recipe ${recipe}`);
  }
}
function dispatch(client: Client, fixture: Fixture, signal?: AbortSignal) {
  const event = eventFor(fixture); const options = signal === undefined ? undefined : { signal };
  switch (fixture.operation.name) {
    case 'user_registration': return client.userRegistration(event, options); case 'user_login': return client.userLogin(event, options);
    case 'order_created': return client.orderCreated(event, options); case 'order_paid': return client.orderPaid(fixture.operation.amount, fixture.operation.currency, event, options);
    case 'custom_event': return client.customEvent(fixture.operation.event_key, event, options);
    default: throw new Error(`unknown operation ${fixture.operation.name}`);
  }
}
async function journal(): Promise<any[]> {
  const response = await control('/__control/requests'); expect(response.status).toBe(200);
  const envelope: unknown = await response.json();
  (await journalValidator)(envelope);
  return (envelope as { requests: any[] }).requests;
}
async function waitForJournal(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) { if ((await journal()).length > 0) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('timed out waiting for mock journal');
}
function assertResult(fixture: Fixture, result: unknown, error: unknown, observedBodies: BoundedBody[]): void {
  const expected = fixture.expect;
  expect(String(error ?? '')).not.toContain(token);
  if (expected.result === 'acknowledgement') {
    expect(error).toBeUndefined();
    expect(result).toMatchObject(expected.acknowledgement === undefined ? { success: true } : { success: true, message: expected.acknowledgement.message, eventKey: expected.acknowledgement.event_key, validatedProperties: expected.acknowledgement.validated_properties });
  } else {
    expect(error).toBeDefined();
    if (expected.result === 'validation_error') expect(error).toBeInstanceOf(ValidationError);
    else if (expected.result === 'authentication_error') expect(error).toBeInstanceOf(AuthenticationError);
    else if (expected.result === 'event_definition_not_found_error') expect(error).toBeInstanceOf(EventDefinitionNotFoundError);
    else if (expected.result === 'api_error') expect(error).toBeInstanceOf(ApiError);
    else if (expected.result === 'transport_error') expect(error).toBeInstanceOf(TransportError);
    else if (expected.result === 'response_decode_error') expect(error).toBeInstanceOf(ResponseDecodeError);
    else if (expected.result === 'caller_cancelled') expect(error).not.toBeInstanceOf(Error);
    if (expected.error_message !== undefined) expect((error as Error).message).toBe(expected.error_message);
    if (expected.status !== undefined) expect((error as any).status).toBe(expected.status);
    if (expected.server_error !== undefined) expect((error as Error).message).toBe(expected.server_error);
    if (expected.server_code !== undefined) expect((error as any).code).toBe(expected.server_code);
    if (expected.result !== 'caller_cancelled' && expected.result !== 'validation_error') {
      expect((error as any).attempts).toBe(expected.attempts);
      expect((error as any).deliveryOutcomeUnknown).toBe(expected.delivery_outcome_unknown ?? false);
    }
    if (expected.retained_body_bytes !== undefined) {
      const bytes = fixture.response_body_recipe === undefined ? new TextEncoder().encode((error as any).rawBody) : new TextEncoder().encode(expandBodyRecipe(fixture.response_body_recipe));
      if (fixture.response_body_recipe !== undefined) expect(bytes.byteLength).toBeGreaterThan(expected.retained_body_bytes);
      expect((error as any).rawBody).toBe(new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, expected.retained_body_bytes)));
    }
  }
  if (expected.observed_body_bytes !== undefined || expected.body_truncated !== undefined) {
    expect(observedBodies).toHaveLength(1);
    expect(observedBodies[0]?.observedBodyBytes).toBe(expected.observed_body_bytes);
    expect(observedBodies[0]?.bodyTruncated).toBe(expected.body_truncated);
  }
}
const GENERATED_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const USER_AGENT = /^cekat-event-sdk-node\/\d+\.\d+\.\d+\S*( .+)?$/;
async function assertJournal(fixture: Fixture, window: { started: number; finished: number }): Promise<void> {
  const entries = await journal(); expect(entries).toHaveLength(fixture.expect.attempts);
  for (const entry of entries) { expect(entry.headers['user-agent']).toHaveLength(1); expect(entry.headers['user-agent'][0]).toMatch(USER_AGENT); }
  if (fixture.expect.request === undefined) return;
  const generated = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    expect(entry).toMatchObject({ sequence: index + 1, method: 'POST', path: fixture.expect.request.path });
    expect(entry.headers.authorization).toEqual([fixture.expect.request.authorization]);
    const actual = JSON.parse(entry.body);
    for (const field of ['event_id', 'occurred_at']) {
      if (field in fixture.expect.request.payload) continue;
      const value = actual[field];
      if (field === 'event_id') expect(value).toMatch(GENERATED_EVENT_ID);
      else {
        expect(value).toMatch(CANONICAL_OCCURRED_AT);
        expect(Date.parse(value)).toBeGreaterThanOrEqual(window.started - 1_000);
        expect(Date.parse(value)).toBeLessThanOrEqual(window.finished + 1_000);
      }
      if (generated.has(field)) expect(value).toBe(generated.get(field));
      generated.set(field, value);
      delete actual[field];
    }
    expect(actual).toEqual(fixture.expect.request.payload);
  }
}
async function execute(fixture: Fixture): Promise<void> {
  await resetAndQueue(fixture);
  const controller = fixture.cancellation === undefined ? undefined : new AbortController();
  const observedBodies: BoundedBody[] = []; const delays: number[] = [];
  let enteredBackoff!: () => void;
  const backoffStarted = new Promise<void>((resolve) => { enteredBackoff = resolve; });
  const client = createClientForTesting(token, { baseURL, ...(fixture.client?.timeout_ms === undefined ? {} : { timeoutMs: fixture.client.timeout_ms }), ...(fixture.client?.retry_count === undefined ? {} : { retryCount: fixture.client.retry_count }) }, {
    random: () => 0.5,
    observeBody: (body) => observedBodies.push(body),
    sleep: async (milliseconds, signal) => {
      delays.push(milliseconds); enteredBackoff();
      if (fixture.cancellation?.phase === 'during_backoff') controller!.abort('caller cancelled');
      if (signal?.aborted) throw signal.reason;
    },
  });
  if (fixture.cancellation?.phase === 'before_request') controller!.abort('caller cancelled');
  const invoke = async () => {
    if (fixture.cancellation?.phase === 'during_request') void waitForJournal().then(() => controller!.abort('caller cancelled'));
    if (fixture.cancellation?.phase === 'during_backoff') void backoffStarted;
    return dispatch(client, fixture, controller?.signal);
  };
  let result: unknown; let error: unknown;
  const started = Date.now();
  try {
    const inbound = fixture.inbound;
    if (inbound?.header_visitor_id !== undefined || inbound?.cookie_visitor_id !== undefined) result = await runWithVisitorFromHeaders({ 'x-cekat-visitor-id': inbound.header_visitor_id, cookie: inbound.cookie_visitor_id === undefined ? undefined : `_cekat_visitor_id=${inbound.cookie_visitor_id}` }, undefined, invoke);
    else if (inbound?.ambient_visitor_id !== undefined) result = await runWithVisitorId(inbound.ambient_visitor_id, invoke); else result = await invoke();
  } catch (caught) { error = caught; }
  const finished = Date.now();
  assertResult(fixture, result, error, observedBodies);
  if (fixture.expect.minimum_retry_delays_ms !== undefined) {
    expect(delays).toHaveLength(fixture.expect.minimum_retry_delays_ms.length);
    for (const [index, minimum] of fixture.expect.minimum_retry_delays_ms.entries()) expect(delays[index]).toBeGreaterThanOrEqual(minimum);
  }
  if (fixture.expect.jitter_bounds_ms !== undefined) {
    expect(delays).toHaveLength(fixture.expect.jitter_bounds_ms.length);
    for (const [index, [minimum, maximum]] of fixture.expect.jitter_bounds_ms.entries()) {
      expect(delays[index]).toBeGreaterThanOrEqual(minimum);
      expect(delays[index]).toBeLessThanOrEqual(maximum);
    }
  }
  await assertJournal(fixture, { started, finished });
}

describe('shared fixture schema validation', () => {
  test('rejects malformed nested mock, expectation, acknowledgement, request, and jitter contracts', async () => {
    const validate = await loadFixtureValidator();
    const fixture = JSON.parse(await readFile(join(root, 'conformance/fixtures/cases/retry-500-500-success.json'), 'utf8'));
    for (const mutate of [
      (value: any) => { value.responses[0].headers = 1; },
      (value: any) => { value.expect.status = '400'; },
      (value: any) => { value.expect.request.extra = true; },
      (value: any) => { value.expect.acknowledgement = { success: true }; },
      (value: any) => { value.expect.jitter_bounds_ms = [[0, 101], [0, 200]]; },
    ]) { const invalid = structuredClone(fixture); mutate(invalid); expect(() => validate(invalid)).toThrow('shared JSON schema'); }
  });
});

describe.skipIf(!configured)('shared Node SDK conformance', () => {
  test('validates and executes every directly discovered fixture exactly once', async () => {
    assertOrigin(baseURL, 'CEKAT_CONFORMANCE_BASE_URL'); assertOrigin(controlURL, 'CEKAT_CONFORMANCE_CONTROL_URL');
    const fixtures = await discoverFixtures(fixturesDirectory); const executed = new Set<string>();
    for (const fixture of fixtures) { await execute(fixture); if (executed.has(fixture.id)) throw new Error(`fixture ${fixture.id} executed more than once`); executed.add(fixture.id); process.stdout.write(`${JSON.stringify({ id: fixture.id, status: 'passed' })}\n`); }
    expect(executed).toEqual(new Set(fixtures.map((fixture) => fixture.id)));
  }, 30_000);
});
