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
