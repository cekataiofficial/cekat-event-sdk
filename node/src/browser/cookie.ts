import { VISITOR_COOKIE } from './constants.js';

/** Reads the exact visitor cookie without decoding or authenticating its value. */
export function readVisitorId(cookieSource: string = documentCookie()): string | undefined {
  for (const cookie of cookieSource.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator === -1 || cookie.slice(0, separator).trim() !== VISITOR_COOKIE) continue;

    const visitorId = cookie.slice(separator + 1).trim();
    if (visitorId !== '') return visitorId;
  }

  return undefined;
}

function documentCookie(): string {
  return typeof document === 'undefined' ? '' : document.cookie;
}
