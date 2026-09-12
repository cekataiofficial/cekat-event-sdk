import type { RequestHandler } from 'express';

import { runWithVisitorFromRequest } from '../node/visitor-context.js';

/** Creates Express middleware that scopes the current request visitor ID. */
export function visitorMiddleware(): RequestHandler {
  return (request, _response, next) => runWithVisitorFromRequest(request, next);
}
