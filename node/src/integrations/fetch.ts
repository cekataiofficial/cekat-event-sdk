import { runWithVisitorFromHeaders } from '../node/visitor-context.js';

/**
 * Runs `callback` in a visitor scope derived from a Web `Request`.
 *
 * Use it in any server runtime whose handlers receive a standard `Request` and that provides
 * `AsyncLocalStorage`: Bun, Node.js (for example with Hono), and Deno. The header
 * `X-Cekat-Visitor-ID` wins over the `_cekat_visitor_id` cookie; values are trimmed.
 *
 * ```ts
 * // Hono middleware
 * app.use((c, next) => runWithCekatVisitor(c.req.raw, next));
 * ```
 */
export function runWithCekatVisitor<TResult>(request: Request, callback: () => TResult): TResult {
  return runWithVisitorFromHeaders(request.headers, request.headers.get('cookie') ?? undefined, callback);
}

/**
 * Wraps a fetch-style handler `(request, ...rest) => Response` so the whole handler runs in the
 * request's visitor scope. `this` and additional arguments (such as Bun's `server`) pass through.
 *
 * ```ts
 * Bun.serve({ fetch: withCekatVisitor((request, server) => app.fetch(request, server)) });
 * Bun.serve({ routes: { '/checkout': { POST: withCekatVisitor(checkout) } } });
 * ```
 *
 * The scope covers code that runs while the handler executes, including awaited work and tasks it
 * starts. A streaming response body pulled after the handler returns may not observe it; read
 * `currentVisitorId()` inside the handler and pass the value along instead.
 */
export function withCekatVisitor<TThis, TRequest extends Request, TRest extends unknown[], TResult>(
  handler: (this: TThis, request: TRequest, ...rest: TRest) => TResult,
): (this: TThis, request: TRequest, ...rest: TRest) => TResult {
  if (typeof handler !== 'function') throw new TypeError('withCekatVisitor requires a handler function');
  return function cekatVisitorHandler(this: TThis, request: TRequest, ...rest: TRest): TResult {
    return runWithCekatVisitor(request, () => handler.call(this, request, ...rest));
  };
}

export { currentVisitorId } from '../node/visitor-context.js';
