import { describe, expect, it } from 'vitest';
import {
  compareCliVersions,
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

describe('chat CLI version policy', () => {
  it('parses versions out of CLI output', () => {
    expect(parseCliVersion('2.1.300 (Claude Code)')).toBe('2.1.300');
    expect(parseCliVersion('codex-cli 0.159.3')).toBe('0.159.3');
    expect(parseCliVersion('1.0.92-beta.1')).toBe('1.0.92-beta.1');
    expect(parseCliVersion('no version')).toBeUndefined();
    expect(parseCliVersion(undefined)).toBeUndefined();
  });

  it('compares numerically, with prereleases before their release', () => {
    expect(compareCliVersions('2.1.300', '2.1.31')).toBe(1);
    expect(compareCliVersions('2.1.300', '2.1.300')).toBe(0);
    expect(compareCliVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareCliVersions('0.9.9', '1.0.0')).toBe(-1);
  });

  it('keeps chat on inside the tested range and for unknown versions', () => {
    expect(evaluateCliVersion('claude_agent_sdk', 'claude-code', '2.1.300 (Claude Code)', policy())).toEqual({ status: 'ok', version: '2.1.300' });
    expect(evaluateCliVersion('claude_agent_sdk', 'claude-code', undefined, policy()).status).toBe('unknown');
    expect(evaluateCliVersion('copilot_acp', 'copilot-cli', '9.9.9', policy()).status).toBe('ok');
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

  it('drops malformed remote denylist entries', () => {
    expect(sanitizeDenylist('nope')).toEqual([]);
    expect(sanitizeDenylist([
      { driver: 'claude_agent_sdk', versions: ['2.1.1'], reason: 'bad' },
      { provider: 'codex-cli', range: { to: '0.150.0' }, reason: 'old protocol', extra: 1 },
      { versions: ['1.0.0'], reason: 'no target' },
      { provider: 'x', reason: 'no versions' },
      { provider: 'x', versions: ['1.0.0'] },
      null,
    ])).toEqual([
      { driver: 'claude_agent_sdk', versions: ['2.1.1'], reason: 'bad' },
      { provider: 'codex-cli', range: { to: '0.150.0' }, reason: 'old protocol' },
    ]);
  });
});
