/** A parsed, explicit browser destination allowed to receive a visitor header. */
export interface AllowedTarget {
  origin: string;
  pathPrefix?: string;
}

/** Canonical representation used for matching and installation identity. */
export interface NormalizedAllowedTarget {
  readonly origin: string;
  readonly pathPrefix: string;
}

function normalizeAllowedTarget(target: AllowedTarget): NormalizedAllowedTarget {
  let parsed: URL;
  try {
    parsed = new URL(target.origin);
  } catch {
    throw new TypeError('Allowed target origin must be an absolute HTTP(S) origin.');
  }

  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== '') {
    throw new TypeError('Allowed target origin must be an HTTP(S) origin without credentials, paths, queries, or fragments.');
  }

  const pathPrefix = target.pathPrefix ?? '/';
  if (!pathPrefix.startsWith('/')) {
    throw new TypeError('Allowed target pathPrefix must begin with "/".');
  }

  return { origin: parsed.origin, pathPrefix };
}

/** Validates, canonicalizes, deduplicates, and sorts an explicit target allowlist. */
export function normalizeAllowedTargets(targets: readonly AllowedTarget[]): readonly NormalizedAllowedTarget[] {
  if (targets.length === 0) throw new TypeError('At least one allowed target is required.');

  const normalized = targets.map(normalizeAllowedTarget);
  const unique = new Map(normalized.map((target) => [`${target.origin}\u0000${target.pathPrefix}`, target]));
  return [...unique.values()].sort((left, right) => left.origin.localeCompare(right.origin)
    || left.pathPrefix.localeCompare(right.pathPrefix));
}

/** Matches URL components rather than an unsafe raw URL string prefix. */
export function matchesAllowedTarget(targets: readonly NormalizedAllowedTarget[], url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && targets.some((target) => target.origin === url.origin && url.pathname.startsWith(target.pathPrefix));
}
