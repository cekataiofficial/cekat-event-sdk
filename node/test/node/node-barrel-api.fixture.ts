import {
  ApiError,
  AuthenticationError,
  Client,
  EventDefinitionNotFoundError,
  ResponseDecodeError,
  TransportError,
  ValidationError,
  currentVisitorId,
  runWithVisitorFromHeaders,
  runWithVisitorFromRequest,
  runWithVisitorId,
} from '../../src/node/index.js';
import type {
  Acknowledgement,
  CallOptions,
  ClientOptions,
  EventInput,
  FetchLike,
  JsonValue,
} from '../../src/node/index.js';
import * as NodeApi from '../../src/node/index.js';

// @ts-expect-error DeliveryConfig is an internal delivery type, not Node barrel API.
import type { DeliveryConfig } from '../../src/node/index.js';
// @ts-expect-error WirePayload is an internal transport type, not Node barrel API.
import type { WirePayload } from '../../src/node/index.js';

type Assert<T extends true> = T;
type ExpectedValueExportName =
  | 'ApiError'
  | 'AuthenticationError'
  | 'Client'
  | 'EventDefinitionNotFoundError'
  | 'ResponseDecodeError'
  | 'TransportError'
  | 'ValidationError'
  | 'currentVisitorId'
  | 'runWithVisitorFromHeaders'
  | 'runWithVisitorFromRequest'
  | 'runWithVisitorId';
type ValueExportName = keyof typeof NodeApi;
type _NoUnexpectedValueExports = Assert<Exclude<ValueExportName, ExpectedValueExportName> extends never ? true : false>;
type _AllExpectedValueExports = Assert<ExpectedValueExportName extends ValueExportName ? true : false>;

const fetch: FetchLike = async () => new Response(JSON.stringify({
  success: true,
  data: { success: true, message: 'accepted', event_key: 'user_login', validated_properties: [] },
}), { status: 200 });
const clientOptions: ClientOptions = { fetch };
const event: EventInput = { email: 'ada@example.test', properties: { count: 1 } };
const callOptions: CallOptions = {};
const json: JsonValue = { enabled: true };
const acknowledgement: Promise<Acknowledgement> = new Client('token', clientOptions).userLogin(event, callOptions);

const validationError: Error = new ValidationError('invalid');
const apiError: Error = new ApiError('bad request', 400, { rawBody: '', attempts: 1 });
const authenticationError: Error = new AuthenticationError('unauthorized', { rawBody: '', attempts: 1 });
const eventDefinitionError: Error = new EventDefinitionNotFoundError('missing', { rawBody: '', attempts: 1 });
const decodeError: Error = new ResponseDecodeError('invalid response', '', 1);
const transportError: Error = new TransportError('transport failed', 1, new Error('cause'));
const visitorId: string | undefined = currentVisitorId();
const scopedVisitor: string | undefined = runWithVisitorId('visitor', currentVisitorId);
const headerVisitor: string | undefined = runWithVisitorFromHeaders({ 'x-cekat-visitor-id': 'visitor' }, undefined, currentVisitorId);
const requestVisitor: string | undefined = runWithVisitorFromRequest({ headers: {} }, currentVisitorId);

void [
  acknowledgement,
  apiError,
  authenticationError,
  decodeError,
  eventDefinitionError,
  headerVisitor,
  json,
  requestVisitor,
  scopedVisitor,
  transportError,
  validationError,
  visitorId,
];
