import { describe, expect, it } from 'vitest';
import { classifyExportError, sanitizeAttribute, sanitizeAttributes } from './redaction';
import { createScrubber } from './scrubber';
import { MAX_STRING_LENGTH, OTHER } from '../../shared/telemetry/attributes';

const scrub = createScrubber({ homeDir: '/home/bob', username: 'bobsmith', hostname: 'build-box-7' });

/** Deterministic PRNG so fuzz failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Content that must never survive the pipeline (spec §5.5).
const SECRETS = [
  '/home/bob/work/acme-secret/src/app.ts',
  'C:\\Users\\bobsmith\\secret\\repo',
  '\\\\corp-share\\eng\\secret',
  'https://github.com/acme/secret-repo.git',
  'bob@acme-secret.io',
  '10.0.0.42',
  'please refactor the billing module and push to main',
  'Error: ENOENT: no such file or directory, open \'/home/bob/.ssh/id_rsa\'\n    at Object.openSync (node:fs:573:3)',
  'sk-ant-api03-SECRET',
  'feature/acme-secret-branch',
  'build-box-7',
];

const KEYS = [
  'cwd', 'path', 'prompt', 'mission', 'branch', 'repoUrl', 'projectName', 'agentName', 'error', 'stack',
  'msg', 'meta', 'clubhouse.project.name', 'exception.message', 'http.url', 'url.full', 'host.name',
  // Registry keys fed garbage values:
  'clubhouse.outcome', 'clubhouse.agent.id_hash', 'process.exit.code', 'clubhouse.update.from_version',
  'microsoft.custom_event.name', 'exception.type', 'error.type', 'microsoft.sample_rate',
];

function randomValue(r: () => number): unknown {
  const pick = SECRETS[Math.floor(r() * SECRETS.length)];
  switch (Math.floor(r() * 6)) {
    case 0: return pick;
    case 1: return `prefix ${pick} suffix`;
    case 2: return { nested: pick };
    case 3: return [pick, pick];
    case 4: return r() * 1e6;
    default: return pick.repeat(3);
  }
}

describe('redaction fuzz', () => {
  it('lets no path, URL, email, prompt or stack content survive', () => {
    const r = rng(1914);
    for (let i = 0; i < 2000; i++) {
      const bag: Record<string, unknown> = {};
      const n = 1 + Math.floor(r() * 8);
      for (let k = 0; k < n; k++) bag[KEYS[Math.floor(r() * KEYS.length)]] = randomValue(r);
      const { attributes } = sanitizeAttributes(bag, scrub);
      const serialized = JSON.stringify(attributes);
      for (const secret of ['acme', 'bob', 'secret', 'refactor', '10.0.0.42', 'id_rsa', 'sk-ant', 'build-box']) {
        expect(serialized, `iteration ${i}: ${JSON.stringify(bag)}`).not.toContain(secret);
      }
      for (const value of Object.values(attributes)) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(4096);
      }
    }
  });
});

describe('sanitizeAttribute', () => {
  it('drops keys that are not in the registry', () => {
    expect(sanitizeAttribute('cwd', 'x', scrub)).toBeUndefined();
    expect(sanitizeAttribute('host.name', 'x', scrub)).toBeUndefined();
  });

  it('re-validates each attribute kind', () => {
    expect(sanitizeAttribute('clubhouse.outcome', 'ok', scrub)).toBe('ok');
    expect(sanitizeAttribute('clubhouse.outcome', 'weird', scrub)).toBe(OTHER);
    expect(sanitizeAttribute('clubhouse.outcome', 3, scrub)).toBeUndefined();
    expect(sanitizeAttribute('process.exit.code', 1, scrub)).toBe(1);
    expect(sanitizeAttribute('process.exit.code', 1.5, scrub)).toBeUndefined();
    expect(sanitizeAttribute('clubhouse.exception.handled', true, scrub)).toBe(true);
    expect(sanitizeAttribute('clubhouse.exception.handled', 'true', scrub)).toBeUndefined();
    expect(sanitizeAttribute('clubhouse.agent.id_hash', '0123456789abcdef', scrub)).toBe('0123456789abcdef');
    expect(sanitizeAttribute('clubhouse.agent.id_hash', 'agent_raw_id', scrub)).toBeUndefined();
    expect(sanitizeAttribute('clubhouse.update.from_version', '0.43.0-beta.1', scrub)).toBe('0.43.0-beta.1');
    expect(sanitizeAttribute('clubhouse.update.from_version', '/home/bob/x', scrub)).toBeUndefined();
  });

  it('keeps only class-name-shaped exception types and known custom event names', () => {
    expect(sanitizeAttribute('exception.type', 'TypeError', scrub)).toBe('TypeError');
    expect(sanitizeAttribute('exception.type', 'ENOENT: no such file /home/bob', scrub)).toBeUndefined();
    expect(sanitizeAttribute('exception.message', 'TypeError', scrub)).toBe('TypeError');
    expect(sanitizeAttribute('exception.message', 'Cannot read /home/bob', scrub)).toBeUndefined();
    expect(sanitizeAttribute('microsoft.custom_event.name', 'clubhouse.telemetry.test', scrub)).toBe('clubhouse.telemetry.test');
    expect(sanitizeAttribute('microsoft.custom_event.name', 'user typed this', scrub)).toBeUndefined();
  });

  it('caps the stack trace length', () => {
    const out = sanitizeAttribute('exception.stacktrace', 'at f (a.js:1:1)\n'.repeat(1000), scrub) as string;
    expect(out.length).toBe(4096);
    expect(MAX_STRING_LENGTH).toBe(128);
  });
});

describe('classifyExportError', () => {
  it.each([
    [{ statusCode: 503 }, '5xx'],
    [{ statusCode: 401 }, '4xx'],
    [{ statusCode: 308 }, '3xx'],
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ code: 'ECONNREFUSED' }, 'network'],
    [undefined, 'network'],
  ])('%j → %s', (err, expected) => {
    expect(classifyExportError(err)).toBe(expected);
  });
});
