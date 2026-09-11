#!/usr/bin/env node
/**
 * Fails only when an installed direct dependency is behind its declared npm
 * range. npm itself exits 1 when a newer version exists outside that range,
 * which is informational for this exact-version compatibility policy.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function findApprovedRangeDrift(outdated) {
  if (!outdated || typeof outdated !== 'object' || Array.isArray(outdated)) {
    throw new TypeError('npm outdated did not return a JSON object');
  }
  return Object.entries(outdated).flatMap(([name, entry]) => {
    if (!entry || typeof entry !== 'object' || typeof entry.current !== 'string' || typeof entry.wanted !== 'string') {
      return [`${name}: malformed npm outdated entry`];
    }
    return entry.current === entry.wanted ? [] : [`${name}: installed ${entry.current}, approved range resolves to ${entry.wanted}`];
  });
}

export function checkApprovedOutdated({ execFile = execFileSync, stdout = (line) => process.stdout.write(line) } = {}) {
  let output;
  try {
    output = execFile('npm', ['outdated', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    if (!error || typeof error.stdout !== 'string') throw error;
    output = error.stdout;
  }
  const drift = findApprovedRangeDrift(JSON.parse(output || '{}'));
  if (drift.length) throw new Error(`Dependencies behind approved ranges:\n${drift.join('\n')}`);
  stdout('Approved dependency ranges are current.\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    checkApprovedOutdated();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
