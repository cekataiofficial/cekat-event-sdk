import { runWithVisitorFromHeaders, runWithVisitorFromRequest } from '../node/visitor-context.js';

type NodeRequest = { headers: Record<string, string | string[] | undefined> };

/**
 * Wraps a Next Pages/API handler in a Node-only visitor scope.
 *
 * Import this Node-only module only from a route declaring
 * `export const runtime = "nodejs"`. The invocation guard is best-effort
 * after this module and its Node dependencies have already loaded.
 */
export function withCekatVisitor<TRequest extends NodeRequest, TResponse, TResult>(
  handler: (request: TRequest, response: TResponse) => TResult,
): (request: TRequest, response: TResponse) => TResult {
  return (request, response) => {
    assertNodeRuntime();
    return runWithVisitorFromRequest(request, () => handler(request, response));
  };
}

/**
 * Runs an App Router handler in a Node-only visitor scope derived from a Web Request.
 * This Node-only module must be imported only from a `runtime = "nodejs"` route.
 */
export function runWithCekatVisitor<TResult>(request: Request, handler: () => TResult): TResult {
  assertNodeRuntime();
  return runWithVisitorFromHeaders(request.headers, request.headers.get('cookie') ?? undefined, handler);
}

/** Best-effort diagnostic for a misconfigured route after this Node-only module loads. */
function assertNodeRuntime(): void {
  const runtime = globalThis as typeof globalThis & { EdgeRuntime?: unknown };
  if ('EdgeRuntime' in runtime) {
    throw new Error('Next.js Edge runtime is unsupported; use the Node.js runtime (export const runtime = "nodejs").');
  }
}
