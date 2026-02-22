/**
 * Automated check that test/setup-renderer.ts stays in sync with src/preload/index.ts.
 *
 * Parses the preload bridge source to extract the API surface and compares it
 * against the mock in setup-renderer.ts. If a new method is added to the
 * preload bridge but not to the mock, this test will fail.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** Extract top-level namespaces and their method names from source text */
function extractApiKeys(source: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  // Match namespace blocks like `pty: { ... },` at the top level of the api object
  // We look for `key: {` patterns followed by method definitions
  const namespaceRegex = /^\s{2}(\w+):\s*\{/gm;
  let match;

  while ((match = namespaceRegex.exec(source)) !== null) {
    const name = match[1];
    const startIdx = match.index + match[0].length;

    // Find the matching closing brace by counting braces
    let depth = 1;
    let i = startIdx;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      if (source[i] === '}') depth--;
      i++;
    }
    const block = source.slice(startIdx, i - 1);

    // Extract method/property names — look for `name:` or `name(` patterns at indent level
    const methodNames: string[] = [];
    const methodRegex = /^\s{4}(\w+)\s*[:(]/gm;
    let m;
    while ((m = methodRegex.exec(block)) !== null) {
      methodNames.push(m[1]);
    }

    if (methodNames.length > 0) {
      result[name] = [...new Set(methodNames)].sort();
    }
  }

  return result;
}

describe('preload bridge sync check', () => {
  const preloadPath = path.resolve(__dirname, '../src/preload/index.ts');
  const setupPath = path.resolve(__dirname, './setup-renderer.ts');

  it('setup-renderer.ts mock covers all preload API namespaces', () => {
    const preloadSource = fs.readFileSync(preloadPath, 'utf-8');
    const setupSource = fs.readFileSync(setupPath, 'utf-8');

    const preloadApi = extractApiKeys(preloadSource);
    const setupApi = extractApiKeys(setupSource);

    // Check that every namespace in the preload exists in the setup
    for (const ns of Object.keys(preloadApi)) {
      expect(
        setupApi,
        `Missing namespace "${ns}" in setup-renderer.ts`,
      ).toHaveProperty(ns);
    }
  });

  it('setup-renderer.ts mock covers all preload API methods', () => {
    const preloadSource = fs.readFileSync(preloadPath, 'utf-8');
    const setupSource = fs.readFileSync(setupPath, 'utf-8');

    const preloadApi = extractApiKeys(preloadSource);
    const setupApi = extractApiKeys(setupSource);

    const missingMethods: string[] = [];

    for (const [ns, methods] of Object.entries(preloadApi)) {
      if (!setupApi[ns]) continue; // namespace-level check is separate
      for (const method of methods) {
        if (!setupApi[ns].includes(method)) {
          missingMethods.push(`${ns}.${method}`);
        }
      }
    }

    expect(
      missingMethods,
      `Methods in preload but missing from setup-renderer.ts:\n  ${missingMethods.join('\n  ')}`,
    ).toEqual([]);
  });
});
