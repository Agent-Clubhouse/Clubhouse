import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { KNOWN_LOG_NAMESPACES, listLogNamespaces } from './log-namespaces';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === '__fixtures__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** Namespaces passed as a literal to appLog/rendererLog, or held in a `*NS` constant. */
function namespacesInSource(): Map<string, string> {
  const found = new Map<string, string>();
  const patterns = [
    /\b(?:appLog|rendererLog)\(\s*'([^']+)'/g,
    /\bconst\s+(?:[A-Z_]+_)?NS\s*=\s*'([^']+)'/g,
  ];
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) found.set(m[1], path.relative(SRC, file));
    }
  }
  return found;
}

describe('KNOWN_LOG_NAMESPACES (#2312)', () => {
  it('lists every namespace the source logs to', () => {
    const inSource = namespacesInSource();
    // Guards the scan itself: a regex that stops matching would pass vacuously.
    expect(inSource.size).toBeGreaterThan(40);
    const missing = [...inSource]
      .filter(([ns]) => !KNOWN_LOG_NAMESPACES.includes(ns))
      .map(([ns, file]) => `${ns} (${file})`);
    expect(missing).toEqual([]);
  });

  it('has no duplicates and no plugin namespaces', () => {
    expect(new Set(KNOWN_LOG_NAMESPACES).size).toBe(KNOWN_LOG_NAMESPACES.length);
    expect(KNOWN_LOG_NAMESPACES.filter((ns) => ns.startsWith('plugin:'))).toEqual([]);
  });
});

describe('listLogNamespaces', () => {
  it('lists known namespaces before any line is written', () => {
    expect(listLogNamespaces([])).toEqual([...KNOWN_LOG_NAMESPACES].sort());
  });

  it('adds namespaces seen this run, sorted and without duplicates', () => {
    const list = listLogNamespaces(['plugin:hub', 'core:pty']);
    expect(list).toContain('plugin:hub');
    expect(list.filter((ns) => ns === 'core:pty')).toHaveLength(1);
    expect(list).toEqual([...list].sort());
  });
});
