import { matchesAllowedTarget, normalizeAllowedTargets } from './allowlist.js';
import type { AllowedTarget, NormalizedAllowedTarget } from './allowlist.js';
import { VISITOR_HEADER } from './constants.js';
import { readVisitorId } from './cookie.js';
import { withVisitorRequest } from './explicit.js';

/** Options for opt-in global fetch and XMLHttpRequest visitor propagation. */
export interface AutoPropagationOptions {
  readonly allowedTargets: readonly AllowedTarget[];
}

type Disable = () => void;
type Open = (this: XMLHttpRequest, ...args: unknown[]) => void;
type SetRequestHeader = (this: XMLHttpRequest, name: string, value: string) => void;
type Send = (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) => void;

interface XhrState {
  readonly url: URL | undefined;
  explicitVisitorHeader: boolean;
  injectedVisitorHeader: boolean;
}

interface Installation {
  readonly canonicalTargets: string;
  readonly disable: Disable;
}

let activeInstallation: Installation | undefined;

function canonicalTargets(targets: readonly NormalizedAllowedTarget[]): string {
  return JSON.stringify(targets);
}

function parseUrl(url: unknown): URL | undefined {
  try {
    return new URL(String(url), globalThis.location.href);
  } catch {
    return undefined;
  }
}

/**
 * Installs opt-in visitor propagation for fetch and XMLHttpRequest.
 * Only explicit HTTP(S) origin/path allowlist entries can receive the header.
 */
export function enableAutoPropagation(options: AutoPropagationOptions): Disable {
  const targets = normalizeAllowedTargets(options.allowedTargets);
  const canonical = canonicalTargets(targets);
  if (activeInstallation !== undefined) {
    if (activeInstallation.canonicalTargets === canonical) return activeInstallation.disable;
    throw new Error('Automatic visitor propagation is already enabled with a different configuration. Disable it before enabling a new configuration.');
  }

  const originalFetch = globalThis.fetch;
  const xhrPrototype = globalThis.XMLHttpRequest.prototype;
  const originalOpen = xhrPrototype.open as Open;
  const originalSetRequestHeader = xhrPrototype.setRequestHeader as SetRequestHeader;
  const originalSend = xhrPrototype.send as Send;
  const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();

  const wrappedFetch: typeof globalThis.fetch = (input, init) => {
    // Request(input, init) consumes a Request's body. Clone it first so the caller's
    // Request remains usable while the single constructed request carries its settings.
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    return originalFetch(matchesAllowedTarget(targets, new URL(request.url)) ? withVisitorRequest(request) : request);
  };

  const wrappedOpen: Open = function wrappedOpen(this: XMLHttpRequest, ...args: unknown[]): void {
    originalOpen.call(this, ...args);
    xhrStates.set(this, {
      url: parseUrl(args[1]),
      explicitVisitorHeader: false,
      injectedVisitorHeader: false,
    });
  };

  const wrappedSetRequestHeader: SetRequestHeader = function wrappedSetRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    originalSetRequestHeader.call(this, name, value);
    if (name.toLowerCase() === VISITOR_HEADER) {
      const state = xhrStates.get(this);
      if (state !== undefined) state.explicitVisitorHeader = true;
    }
  };

  const wrappedSend: Send = function wrappedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const state = xhrStates.get(this);
    const visitorId = readVisitorId();
    if (state !== undefined
      && state.url !== undefined
      && matchesAllowedTarget(targets, state.url)
      && !state.explicitVisitorHeader
      && !state.injectedVisitorHeader
      && visitorId !== undefined) {
      originalSetRequestHeader.call(this, VISITOR_HEADER, visitorId);
      state.injectedVisitorHeader = true;
    }
    return originalSend.call(this, body);
  };

  globalThis.fetch = wrappedFetch;
  xhrPrototype.open = wrappedOpen as XMLHttpRequest['open'];
  xhrPrototype.setRequestHeader = wrappedSetRequestHeader;
  xhrPrototype.send = wrappedSend as XMLHttpRequest['send'];

  let disabled = false;
  const disable: Disable = () => {
    if (disabled) return;
    disabled = true;
    globalThis.fetch = originalFetch;
    xhrPrototype.open = originalOpen as XMLHttpRequest['open'];
    xhrPrototype.setRequestHeader = originalSetRequestHeader;
    xhrPrototype.send = originalSend as XMLHttpRequest['send'];
    if (activeInstallation?.disable === disable) activeInstallation = undefined;
  };
  activeInstallation = { canonicalTargets: canonical, disable };
  return disable;
}
