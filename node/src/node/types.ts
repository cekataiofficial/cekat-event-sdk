/** A value that can be represented in a JSON event property. */
export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

export interface EventInput {
  email?: string;
  phoneNumber?: string;
  contactName?: string;
  visitorId?: string;
  properties?: Record<string, JsonValue>;
}

export interface Acknowledgement {
  success: true;
  message: string;
  eventKey: string;
  validatedProperties: string[];
  rawBody: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseURL?: string;
  timeoutMs?: number;
  retryCount?: number;
  fetch?: FetchLike;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/** Internal representation sent to the ingest endpoint. */
export interface WirePayload {
  event_key: string;
  is_common: boolean;
  email?: string;
  phone_number?: string;
  contact_name?: string;
  visitor_id?: string;
  properties?: Record<string, JsonValue>;
}
