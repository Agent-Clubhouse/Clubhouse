import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/main/services/settings-store', () => ({
  createSettingsStore: () => ({ get: () => ({ entries: [] }), save: async () => {} }),
}));

import {
  KNOWN_DRIVERS,
  KNOWN_PROVIDERS,
  MAX_DENYLIST_ENTRIES as SCRIPT_MAX_ENTRIES,
  MAX_VERSIONS_PER_ENTRY as SCRIPT_MAX_VERSIONS,
  compareVersions,
  main,
  readList,
  setManifestList,
  validateDenylist,
} from './cli-denylist.mjs';
import {
  MAX_DENYLIST_ENTRIES,
  MAX_VERSIONS_PER_ENTRY,
  TESTED_CLI_VERSIONS,
  cliLabel,
  compareCliVersions,
  sanitizeDenylist,
} from '../../src/main/services/agent-runtime/chat-version-policy';

const REPO = path.resolve(__dirname, '../..');
const REASON = 'hangs on start';
const entry = (over: Record<string, unknown> = {}) => ({ provider: 'claude-code', versions: ['2.1.250'], reason: REASON, ...over });
const without = (key: string) => { const e: Record<string, unknown> = entry(); delete e[key]; return e; };

describe('validateDenylist against the client', () => {
  it('uses the same caps', () => {
    expect(SCRIPT_MAX_ENTRIES).toBe(MAX_DENYLIST_ENTRIES);
    expect(SCRIPT_MAX_VERSIONS).toBe(MAX_VERSIONS_PER_ENTRY);
  });

  // Whatever passes here reaches a client's list byte for byte, so nothing that
  // passes can be dropped or rewritten at the other end.
  it.each([
    ['one version', entry()],
    ['a prerelease', entry({ versions: ['1.0.106-2', '1.0.92-beta.1'] })],
    ['a driver', { driver: 'copilot_sdk', versions: ['1.0.105'], reason: REASON }],
    ['a closed range', { provider: 'codex-cli', range: { from: '0.160.0', to: '0.166.0' }, reason: REASON }],
    ['a range open at the top', { provider: 'codex-cli', range: { from: '0.160.0' }, reason: REASON }],
    ['a range open at the bottom', { provider: 'codex-cli', range: { to: '0.166.0' }, reason: REASON }],
    ['versions and a range', entry({ range: { from: '3.0.0', to: '3.0.0' } })],
    ['the longest reason', entry({ reason: 'x'.repeat(300) })],
    ['the longest version', entry({ versions: [`1.0.0-${'a'.repeat(58)}`] })],
    ['the most versions', entry({ versions: Array.from({ length: MAX_VERSIONS_PER_ENTRY }, (_, i) => `1.0.${i}`) })],
  ])('accepts %s, and a client keeps it unchanged', (_label, e) => {
    expect(validateDenylist([e])).toEqual([]);
    expect(sanitizeDenylist([e])).toEqual([e]);
  });

  it.each(KNOWN_DRIVERS)('accepts the driver %s', (driver) => {
    const e = { driver, versions: ['1.0.0'], reason: REASON };
    expect(validateDenylist([e])).toEqual([]);
    expect(sanitizeDenylist([e])).toEqual([e]);
  });

  it.each(KNOWN_PROVIDERS)('accepts the provider %s', (provider) => {
    const e = entry({ provider });
    expect(validateDenylist([e])).toEqual([]);
    expect(sanitizeDenylist([e])).toEqual([e]);
  });

  it('accepts the most entries, and a client keeps them all', () => {
    const list = Array.from({ length: MAX_DENYLIST_ENTRIES }, () => entry());
    expect(validateDenylist(list)).toEqual([]);
    expect(sanitizeDenylist(list)).toHaveLength(MAX_DENYLIST_ENTRIES);
  });

  // Every shape a client would drop without telling anyone.
  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['an array', []],
    ['no reason', without('reason')],
    ['an empty reason', entry({ reason: '' })],
    ['a reason that is not a string', entry({ reason: 7 })],
    ['a reason that is too long', entry({ reason: 'x'.repeat(301) })],
    ['no driver or provider', without('provider')],
    ['a provider that is not a string', entry({ provider: 7 })],
    ['a provider that is too long', entry({ provider: 'x'.repeat(65) })],
    ['no versions or range', without('versions')],
    ['versions that are not an array', entry({ versions: '2.1.250' })],
    ['empty versions alone', entry({ versions: [] })],
    ['too many versions', entry({ versions: Array.from({ length: MAX_VERSIONS_PER_ENTRY + 1 }, (_, i) => `1.0.${i}`) })],
    ['a wildcard version', entry({ versions: ['2.1.*'] })],
    ['a two-part version', entry({ versions: ['2.1'] })],
    ['a v prefix', entry({ versions: ['v2.1.250'] })],
    ['text around a version', entry({ versions: ['2.1.250 (Claude Code)'] })],
    ['a version that is not a string', entry({ versions: [2] })],
    ['a version that is too long', entry({ versions: [`1.0.0-${'a'.repeat(59)}`] })],
    ['one bad version among good ones', entry({ versions: ['2.1.250', 'bad'] })],
    ['a range that is not an object', entry({ versions: undefined, range: '2.1.0' })],
    ['an empty range', entry({ versions: undefined, range: {} })],
    ['a bad range.from', entry({ versions: undefined, range: { from: 'x', to: '2.1.0' } })],
    ['a bad range.to', entry({ versions: undefined, range: { from: '2.1.0', to: 'x' } })],
  ])('fails on %s, which a client would drop', (_label, e) => {
    const value = e && typeof e === 'object' && !Array.isArray(e) ? JSON.parse(JSON.stringify(e)) : e;
    expect(validateDenylist([value]).length).toBeGreaterThan(0);
    expect(sanitizeDenylist([value])).toEqual([]);
  });

  it('fails past the entry cap, where a client would ignore the rest', () => {
    const list = Array.from({ length: MAX_DENYLIST_ENTRIES + 1 }, () => entry());
    expect(validateDenylist(list).join()).toContain(`first ${MAX_DENYLIST_ENTRIES}`);
    expect(sanitizeDenylist(list)).toHaveLength(MAX_DENYLIST_ENTRIES);
  });

  // Accepted by a client, which then does something other than what was written.
  it.each([
    ['a blank reason', entry({ reason: '   ' })],
    ['an unknown provider, which never matches', entry({ provider: 'claude' })],
    ['an unknown driver, which never matches', { driver: 'claude_sdk', versions: ['1.0.0'], reason: REASON }],
    ['both a driver and a provider, where provider is ignored', { driver: 'claude_agent_sdk', provider: 'codex-cli', versions: ['1.0.0'], reason: REASON }],
    ['an unknown field', entry({ version: '2.1.251' })],
    ['a misspelled range field, which widens the range', entry({ versions: undefined, range: { form: '2.1.0', to: '2.1.5' } })],
    ['a range that runs backwards', entry({ versions: undefined, range: { from: '2.1.5', to: '2.1.0' } })],
    ['leading zeros, which a client rewrites', entry({ versions: ['02.1.250'] })],
    ['build metadata, which a client strips', entry({ versions: ['2.1.250+abc'] })],
    ['spaces, which a client trims', entry({ versions: [' 2.1.250 '] })],
    ['empty versions beside a range, which a client removes', entry({ versions: [], range: { to: '2.1.0' } })],
  ])('fails on %s', (_label, e) => {
    expect(validateDenylist([JSON.parse(JSON.stringify(e))]).length).toBeGreaterThan(0);
  });

  it.each([[{}], ['nope'], [7], [null]])('fails when the list itself is %j', (list) => {
    expect(validateDenylist(list).length).toBeGreaterThan(0);
  });

  it('says which entry is wrong and why', () => {
    expect(validateDenylist([entry(), without('reason')])).toEqual(['entry 1 needs a reason, which users see']);
  });

  it('orders versions the way a client does', () => {
    const versions = ['1.0.0', '1.0.1', '1.0.0-1', '1.0.0-alpha', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0-rc.1.1', '0.9.9', '2.1.31', '2.1.300'];
    for (const a of versions) {
      for (const b of versions) {
        expect(compareVersions(a, b), `${a} vs ${b}`).toBe(compareCliVersions(a, b));
      }
    }
  });
});

describe('the known ids', () => {
  it('cover every driver with a tested version range', () => {
    expect(KNOWN_DRIVERS).toEqual(expect.arrayContaining(Object.keys(TESTED_CLI_VERSIONS)));
  });

  it('are all providers a client has a label for', () => {
    for (const provider of KNOWN_PROVIDERS) expect(cliLabel(provider)).not.toBe(provider);
  });
});

describe('the committed list', () => {
  it('is valid, so a release reading it never fails on it', () => {
    expect(() => readList(path.join(REPO, 'release/chat-cli-denylist.json'))).not.toThrow();
  });
});

describe('setManifestList', () => {
  const LIST = [entry()];
  const ENCODED = JSON.stringify(LIST);

  it('adds the field after the last one, in the file\'s own layout, changing no other byte', () => {
    const text = '{\n  "version": "1.0.0",\n  "releaseNotes": "caf\u00e9 \\"x\\" \\u2014",\n  "artifacts": {"a": {"size": 1.50}}\n}\n';
    const { status, text: out } = setManifestList(text, LIST);
    expect(status).toBe('updated');
    expect(out).toBe(`{\n  "version": "1.0.0",\n  "releaseNotes": "caf\u00e9 \\"x\\" \\u2014",\n  "artifacts": {"a": {"size": 1.50}},\n  "chatCliDenylist": ${ENCODED}\n}\n`);
  });

  it('adds the field to a file with no whitespace', () => {
    expect(setManifestList('{"version":"1.0.0"}', LIST).text).toBe(`{"version":"1.0.0","chatCliDenylist": ${ENCODED}}`);
  });

  it('replaces the value where it stands', () => {
    const text = '{ "version": "1.0.0",\t"chatCliDenylist": [ ], "minVersion":"0.1.0" }\n';
    expect(setManifestList(text, LIST).text).toBe(`{ "version": "1.0.0",\t"chatCliDenylist": ${ENCODED}, "minVersion":"0.1.0" }\n`);
  });

  it('writes an empty list only as []', () => {
    expect(setManifestList('{"version":"1.0.0"}', []).text).toBe('{"version":"1.0.0","chatCliDenylist": []}');
  });

  it('reports no change when the value already matches, however it is laid out', () => {
    const text = `{"version":"1.0.0","chatCliDenylist": ${JSON.stringify(LIST, null, 2)}}`;
    expect(setManifestList(text, LIST)).toEqual({ status: 'unchanged', text });
  });

  it('matches the file\'s encoding of non-ASCII text', () => {
    const list = [entry({ reason: 'caf\u00e9' })];
    expect(setManifestList('{"version":"1.0.0","releaseNotes":"\\u00e9"}', list).text).toContain('caf\\u00e9');
    expect(setManifestList('{"version":"1.0.0","releaseNotes":"\u00e9"}', list).text).toContain('caf\u00e9');
  });

  it.each([['not JSON', 'nope'], ['an array', '[]'], ['no version', '{}'], ['a truncated file', '{"version":"1.0.0"']])('refuses %s', (_label, text) => {
    expect(() => setManifestList(text, LIST)).toThrow();
  });
});

describe('the CLI', () => {
  let dir: string;
  let log: ReturnType<typeof vi.spyOn>;
  const write = (name: string, content: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const printed = () => log.mock.calls.map((c: unknown[]) => c[0]).join('\n');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-denylist-'));
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['none', null, 0],
    ['clear', [], 0],
    ['entries', [entry()], 1],
  ])('validate reports %s', (state, list, count) => {
    expect(main(['validate', '--list', write('list.json', JSON.stringify(list))])).toBe(0);
    expect(printed()).toBe(`state=${state}\ncount=${count}`);
  });

  it('validate fails on a bad entry, naming the file', () => {
    const file = write('list.json', [without('reason')]);
    expect(() => main(['validate', '--list', file])).toThrow(/can't be published[\s\S]*entry 0 needs a reason/);
  });

  it('validate fails on a file that is not JSON', () => {
    expect(() => main(['validate', '--list', write('list.json', 'nope')])).toThrow(/Can't read/);
  });

  describe('add-to-manifest, the release path', () => {
    const MANIFEST = '{\n  "version": "1.0.0"\n}\n';

    it('leaves the field out when the list is null, which keeps every client\'s list', () => {
      const manifest = write('m.json', MANIFEST);
      expect(main(['add-to-manifest', '--file', manifest, '--list', write('l.json', 'null\n')])).toBe(0);
      expect(readFileSync(manifest, 'utf8')).toBe(MANIFEST);
      expect(printed()).toBe('status=omitted');
    });

    it('writes the entries', () => {
      const manifest = write('m.json', MANIFEST);
      main(['add-to-manifest', '--file', manifest, '--list', write('l.json', [entry()])]);
      expect(JSON.parse(readFileSync(manifest, 'utf8')).chatCliDenylist).toEqual([entry()]);
    });

    it('writes [] when the file says so, so a client offline during a clear still clears', () => {
      const manifest = write('m.json', MANIFEST);
      main(['add-to-manifest', '--file', manifest, '--list', write('l.json', [])]);
      expect(JSON.parse(readFileSync(manifest, 'utf8')).chatCliDenylist).toEqual([]);
    });

    it('fails on a bad entry and leaves the manifest alone', () => {
      const manifest = write('m.json', MANIFEST);
      expect(() => main(['add-to-manifest', '--file', manifest, '--list', write('l.json', [without('reason')])])).toThrow();
      expect(readFileSync(manifest, 'utf8')).toBe(MANIFEST);
    });
  });

  describe('rewrite-manifest, the publish path', () => {
    const run = (list: unknown, ...extra: string[]) => main([
      'rewrite-manifest', '--file', write('m.json', '{"version":"1.0.0"}'), '--out', path.join(dir, 'out.json'),
      '--list', write('l.json', JSON.stringify(list)), ...extra,
    ]);

    it('refuses a null list, since there is nothing to publish', () => {
      expect(() => run(null)).toThrow(/no list to publish/);
      expect(fs.existsSync(path.join(dir, 'out.json'))).toBe(false);
    });

    it('refuses [] unless told to clear', () => {
      expect(() => run([])).toThrow(/empties the saved list/);
      expect(fs.existsSync(path.join(dir, 'out.json'))).toBe(false);
      expect(run([], '--allow-clear')).toBe(0);
      expect(JSON.parse(readFileSync(path.join(dir, 'out.json'), 'utf8')).chatCliDenylist).toEqual([]);
    });

    it('--allow-clear changes nothing about a list with entries', () => {
      expect(run([entry()], '--allow-clear')).toBe(0);
      expect(JSON.parse(readFileSync(path.join(dir, 'out.json'), 'utf8')).chatCliDenylist).toEqual([entry()]);
    });
  });

  it('fails on an unknown command', () => {
    expect(() => main(['nope'])).toThrow(/Unknown command/);
  });
});
