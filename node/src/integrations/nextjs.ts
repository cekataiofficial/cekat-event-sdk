import { runWithVisitorFromHeaders, runWithVisitorFromRequest } from '../node/visitor-context.js';

type NodeRequest = { headers: Record<string, string | string[] | undefined> };

/** Wraps a Next Pages/API handler in a Node-only visitor scope. */
export function withCekatVisitor<TRequest extends NodeRequest, TResponse, TResult>(
  handler: (request: TRequest, response: TResponse) => TResult,
): (request: TRequest, response: TResponse) => TResult {
  return (request, response) => {
    assertNodeRuntime();
    return runWithVisitorFromRequest(request, () => handler(request, response));
  };
}

/** Runs an App Router handler in a Node-only visitor scope derived from a Web Request. */
export function runWithCekatVisitor<TResult>(request: Request, handler: () => TResult): TResult {
  assertNodeRuntime();
  return runWithVisitorFromHeaders(request.headers, request.headers.get('cookie') ?? undefined, handler);
}

function assertNodeRuntime(): void {
  const runtime = globalThis as typeof globalThis & { EdgeRuntime?: unknown };
  if ('EdgeRuntime' in runtime) {
    throw new Error('Next.js Edge runtime is unsupported; use the Node.js runtime (export const runtime = "nodejs").');
  }
}
