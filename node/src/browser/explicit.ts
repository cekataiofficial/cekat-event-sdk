import { VISITOR_HEADER } from './constants.js';
import { readVisitorId } from './cookie.js';

/** Returns a copied RequestInit whose headers contain the current visitor when absent. */
export function withVisitor(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  const visitorId = readVisitorId();
  if (visitorId !== undefined && !headers.has(VISITOR_HEADER)) headers.set(VISITOR_HEADER, visitorId);
  return { ...init, headers };
}

/** Returns an immutable Request clone whose headers contain the current visitor when absent. */
export function withVisitorRequest(request: Request): Request {
  return new Request(request.clone(), withVisitor({
    headers: request.headers,
    method: request.method,
    credentials: request.credentials,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    signal: request.signal,
  }));
}
