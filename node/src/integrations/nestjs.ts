import type { NestMiddleware } from '@nestjs/common';

import { runWithVisitorFromRequest } from '../node/visitor-context.js';

/** Nest HTTP middleware that scopes the visitor ID for one request without retaining request state. */
export class CekatVisitorMiddleware implements NestMiddleware {
  use(request: { headers: Record<string, string | string[] | undefined> }, _response: object, next: () => void): void {
    runWithVisitorFromRequest(request, next);
  }
}
