import type { Middleware } from 'koa';

import { runWithVisitorFromHeaders } from '../node/visitor-context.js';

/** Creates Koa middleware that preserves visitor scope across the full onion chain. */
export function visitorMiddleware(): Middleware {
  return (context, next) => runWithVisitorFromHeaders(context.headers, context.headers.cookie, () => next());
}
