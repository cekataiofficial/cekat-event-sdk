import { AsyncLocalStorage } from 'node:async_hooks';

const VISITOR_HEADER = 'x-cekat-visitor-id';
const VISITOR_COOKIE = '_cekat_visitor_id';

const storage = new AsyncLocalStorage<Readonly<{ visitorId?: string }>>();

/** Returns the visitor ID bound to the current asynchronous request scope. */
export function currentVisitorId(): string | undefined {
  return storage.getStore()?.visitorId;
}

/** Runs a callback in an isolated asynchronous visitor scope. */
export function runWithVisitorId<T>(visitorId: string | undefined, callback: () => T): T {
  const normalizedVisitorId = normalizeVisitorId(visitorId);
  const store: Readonly<{ visitorId?: string }> = normalizedVisitorId === undefined
    ? Object.freeze({})
    : Object.freeze({ visitorId: normalizedVisitorId });
  return storage.run(store, callback);
}

/** Extracts a visitor ID from Node request headers before running the callback. */
export function runWithVisitorFromRequest<T>(
  request: { headers: Record<string, string | string[] | undefined> },
  callback: () => T,
): T {
  return runWithVisitorFromHeaders(request.headers, undefined, callback);
}

/** Extracts a visitor ID from Web or Node headers before running the callback. */
export function runWithVisitorFromHeaders<T>(
  headers: Headers | Record<string, unknown>,
  cookieHeader: string | undefined,
  callback: () => T,
): T {
  const visitorId = firstNonblank(headerValues(headers, VISITOR_HEADER))
    ?? visitorIdFromCookies(cookieHeader, headerValues(headers, 'cookie'));
  return runWithVisitorId(visitorId, callback);
}

function visitorIdFromCookies(cookieHeader: string | undefined, headerCookies: readonly string[]): string | undefined {
  if (cookieHeader !== undefined) return visitorIdFromCookie(cookieHeader);
  for (const headerCookie of headerCookies) {
    const visitorId = visitorIdFromCookie(headerCookie);
    if (visitorId !== undefined) return visitorId;
  }
  return undefined;
}

function visitorIdFromCookie(cookieHeader: string): string | undefined {
  for (const cookie of cookieHeader.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() !== VISITOR_COOKIE) continue;
    return normalizeVisitorId(cookie.slice(separator + 1));
  }
  return undefined;
}

function headerValues(headers: Headers | Record<string, unknown>, name: string): string[] {
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value === null ? [] : [value];
  }

  const values: string[] = [];
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== name) continue;
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === 'string'));
  }
  return values;
}

function firstNonblank(values: readonly string[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeVisitorId(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function normalizeVisitorId(visitorId: string | undefined): string | undefined {
  if (visitorId === undefined) return undefined;
  const normalized = visitorId.trim();
  return normalized === '' ? undefined : normalized;
}
