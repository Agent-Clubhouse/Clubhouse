import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ value: { entries: [] as unknown[] }, save: vi.fn() }));
vi.mock('../settings-store', () => ({
  createSettingsStore: () => ({
    get: () => store.value,
    save: (v: { entries: unknown[] }) => store.save(v),
  }),
}));

import {
  MAX_DENYLIST_ENTRIES,
  MAX_VERSIONS_PER_ENTRY,
  applyRemoteCliDenylist,
  compareCliVersions,
  getCliDenylist,
  parseExactVersion,
  evaluateCliVersion,
  parseCliVersion,
  sanitizeDenylist,
  type CliVersionPolicy,
} from './chat-version-policy';

const policy = (over: Partial<CliVersionPolicy> = {}): CliVersionPolicy => ({
  tested: { claude_agent_sdk: { minVersion: '2.1.200', testedMax: '2.1.301' } },
  denylist: [],
  ...over,
});

beforeEach(() => {
  store.value = { entries: [] };
  store.save.mockReset();
  store.save.mockImplementation(async (v: { entries: unknown[] }) => { store.value = v; });
});

describe('chat CLI version policy', () => {
  it('parses versions out of CLI output', () => {
    expect(parseCliVersion('2.1.300 (Claude Code)')).toBe('2.1.300');
    expect(parseCliVersion('codex-cli 0.159.3')).toBe('0.159.3');
    expect(parseCliVersion('1.0.92-beta.1')).toBe('1.0.92-beta.1');
    expect(parseCliVersion('no version')).toBeUndefined();
    expect(parseCliVersion(undefined)).toBeUndefined();
  });

  it('compares by SemVer precedence', () => {
    expect(compareCliVersions('2.1.300', '2.1.31')).toBe(1);
    expect(compareCliVersions('2.1.300', '2.1.300')).toBe(0);
    expect(compareCliVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareCliVersions('0.9.9', '1.0.0')).toBe(-1);
    // Numeric prerelease identifiers compare as numbers, before alphanumeric ones.
    expect(compareCliVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareCliVersions('1.0.0-rc.1', '1.0.0-rc.1.1')).toBe(-1);
    expect(compareCliVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    // Build metadata is ignored.
    expect(compareCliVersions('1.0.0+abc', '1.0.0')).toBe(0);
  });

  it('normalizes versions and drops build metadata', () => {
    expect(parseCliVersion('v02.1.300+build.7 (Claude Code)')).toBe('2.1.300');
    expect(parseExactVersion(' 2.1.300 ')).toBe('2.1.300');
    expect(parseExactVersion('2.1.300-rc.1+x')).toBe('2.1.300-rc.1');
    for (const bad of ['latest', '', '2.1', '2.1.x', '>=2.1.0', 'v2.1.0 beta', 3, null, 'x'.repeat(70)]) {
      expect(parseExactVersion(bad)).toBeUndefined();
    }
  });

  it('keeps chat on inside the tested range and for unknown versions', () => {
    expect(evaluateCliVersion('claude_agent_sdk', 'claude-code', '2.1.300 (Claude Code)', policy())).toEqual({ status: 'ok', version: '2.1.300' });
    expect(evaluateCliVersion('claude_agent_sdk', 'claude-code', undefined, policy()).status).toBe('unknown');
    expect(evaluateCliVersion('copilot_acp', 'copilot-cli', '9.9.9', policy()).status).toBe('ok');
  });

  it('covers the Copilot versions that actually run, including Homebrew\'s pinned 1.0.82', () => {
    for (const driver of ['copilot_acp', 'copilot_sdk'] as const) {
      expect(evaluateCliVersion(driver, 'copilot-cli', '1.0.82').status).toBe('ok');
      expect(evaluateCliVersion(driver, 'copilot-cli', '1.0.98').status).toBe('ok');
      expect(evaluateCliVersion(driver, 'copilot-cli', '1.0.99').status).toBe('untested');
    }
  });

  it('notes a newer-than-tested version without failing it', () => {
    const v = evaluateCliVersion('claude_agent_sdk', 'claude-code', '2.1.400', policy());
    expect(v).toMatchObject({ status: 'untested', version: '2.1.400' });
    expect(v.message).toBe('Claude Code 2.1.400 is newer than the version chat was tested with (2.1.301).');
  });

  it('fails versions below the minimum', () => {
    const v = evaluateCliVersion('claude_agent_sdk', 'claude-code', '2.1.100', policy());
    expect(v.status).toBe('below_min');
    expect(v.message).toMatch(/older than chat supports \(2\.1\.200 or newer\)/);
  });

  it('fails denylisted versions by driver, by provider, exactly or by range', () => {
    const denylist = [
      { driver: 'claude_agent_sdk' as const, versions: ['2.1.250'], reason: 'SDK init hangs' },
      { provider: 'claude-code', range: { from: '2.1.260', to: '2.1.262' }, reason: 'control protocol regression' },
    ];
    expect(evaluateCliVersion('claude_agent_sdk', 'claude-code', '2.1.250', policy({ denylist }))).toMatchObject({
      status: 'known_bad', message: 'Claude Code 2.1.250 is known to break chat: SDK init hangs',
    });
    // The driver-scoped entry doesn't apply to the other Claude driver.
    expect(evaluateCliVersion('claude_stream_json', 'claude-code', '2.1.250', policy({ denylist })).status).toBe('ok');
    expect(evaluateCliVersion('claude_stream_json', 'claude-code', '2.1.261', policy({ denylist })).status).toBe('known_bad');
    expect(evaluateCliVersion('claude_stream_json', 'claude-code', '2.1.263', policy({ denylist })).status).toBe('ok');
  });

  it('drops malformed remote denylist entries whole', () => {
    expect(sanitizeDenylist('nope')).toEqual([]);
    expect(sanitizeDenylist([
      { driver: 'claude_agent_sdk', versions: ['2.1.1'], reason: 'bad' },
      { provider: 'codex-cli', range: { to: '0.150.0' }, reason: 'old protocol', extra: 1 },
      { versions: ['1.0.0'], reason: 'no target' },
      { provider: 'x', reason: 'no versions' },
      { provider: 'x', versions: ['1.0.0'] },
      { provider: 'x', versions: ['1.0.0', 'latest'], reason: 'one bad version drops the entry' },
      { provider: 'x', versions: '1.0.0', reason: 'not an array' },
      { provider: 'x', reason: 'r'.repeat(301), versions: ['1.0.0'] },
      null,
    ])).toEqual([
      { driver: 'claude_agent_sdk', versions: ['2.1.1'], reason: 'bad' },
      { provider: 'codex-cli', range: { to: '0.150.0' }, reason: 'old protocol' },
    ]);
  });

  it('never accepts a range that would match every version', () => {
    for (const range of [{ from: 'latest' }, { from: '', to: '' }, {}, { from: '*' }, { to: 'x.y.z' }, { from: '1.0.0', to: 'latest' }, 'all']) {
      expect(sanitizeDenylist([{ provider: 'claude-code', range, reason: 'typo' }])).toEqual([]);
    }
  });

  it('caps entries and versions per entry', () => {
    const many = Array.from({ length: MAX_DENYLIST_ENTRIES + 5 }, (_, i) => ({ provider: 'p', versions: [`1.0.${i}`], reason: 'r' }));
    expect(sanitizeDenylist(many)).toHaveLength(MAX_DENYLIST_ENTRIES);
    const tooMany = Array.from({ length: MAX_VERSIONS_PER_ENTRY + 1 }, (_, i) => `1.0.${i}`);
    expect(sanitizeDenylist([{ provider: 'p', versions: tooMany, reason: 'r' }])).toEqual([]);
  });

  it('matches exact denylist versions after normalizing', () => {
    const denylist = sanitizeDenylist([{ provider: 'claude-code', versions: ['02.1.250+meta'], reason: 'r' }]);
    expect(evaluateCliVersion('claude_agent_sdk', 'claude-code', '2.1.250 (Claude Code)', policy({ denylist })).status).toBe('known_bad');
  });
});

describe('remote denylist from the update manifest', () => {
  const entry = { provider: 'claude-code', versions: ['2.1.250'], reason: 'hangs' };

  it('replaces the saved list only with an array, and keeps it otherwise', async () => {
    await applyRemoteCliDenylist([entry]);
    expect(getCliDenylist()).toEqual([entry]);
    for (const raw of [undefined, null, {}, 1, 'x']) {
      await applyRemoteCliDenylist(raw);
      expect(getCliDenylist()).toEqual([entry]);
    }
    await applyRemoteCliDenylist([]);
    expect(getCliDenylist()).toEqual([]);
  });

  it('skips the write when nothing changed', async () => {
    await applyRemoteCliDenylist([entry]);
    await applyRemoteCliDenylist([entry, { provider: 'x', reason: 'malformed' }]);
    expect(store.save).toHaveBeenCalledTimes(1);
  });
});
