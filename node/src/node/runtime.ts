/** Identifies the JavaScript server runtime executing the SDK. */
export type ServerRuntime = 'node' | 'bun';

interface RuntimeVersions {
  readonly node?: string | undefined;
  readonly bun?: string | undefined;
}

/**
 * Returns the runtime name and version. Bun also reports a Node compatibility version in
 * `process.versions.node`, so `process.versions.bun` must be checked first.
 */
export function detectRuntime(versions: RuntimeVersions = process.versions): { name: ServerRuntime; version: string } {
  if (typeof versions.bun === 'string' && versions.bun !== '') return { name: 'bun', version: versions.bun };
  return { name: 'node', version: versions.node ?? 'unknown' };
}

/** The `<runtime>/<version>` User-Agent product token, for example `node/24.18.0` or `bun/1.4.2`. */
export function runtimeProductToken(versions?: RuntimeVersions): string {
  const runtime = detectRuntime(versions);
  return `${runtime.name}/${runtime.version}`;
}

/**
 * Bun releases before 1.4.0 can hand a later request a pooled connection that a server closed
 * mid-response: the request then hangs, reads the rest of another response, or is silently re-sent.
 * Opting those releases out of connection reuse (`keepalive: false`) avoids that at the cost of a new
 * connection per attempt. Node.js and Bun 1.4.0+ keep normal pooling.
 */
export function connectionReuseInit(versions?: RuntimeVersions): { keepalive?: false } {
  return isBunBefore14(versions) ? { keepalive: false } : {};
}

/**
 * True on Bun releases before 1.4.0, whose HTTP client has the connection-pool defects handled by
 * {@link connectionReuseInit}. On those releases a response whose connection closes after the headers
 * but before the complete body also rejects `fetch()` itself, so the SDK cannot observe its status and
 * treats it as a transport failure (retried with the same event_id). Bun 1.4.0+ and Node.js are unaffected.
 */
export function isBunBefore14(versions?: RuntimeVersions): boolean {
  const runtime = detectRuntime(versions);
  if (runtime.name !== 'bun') return false;
  const [major = 0, minor = 0] = runtime.version.split('.').map((part) => Number.parseInt(part, 10));
  return major < 1 || (major === 1 && minor < 4);
}
