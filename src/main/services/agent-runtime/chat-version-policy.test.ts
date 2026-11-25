import { describe, expect, it } from 'vitest';

import * as chatVersionPolicy from './chat-version-policy';
import {
  TESTED_CLI_VERSIONS,
  compareCliVersions,
  getCliDenylist,
  parseExactVersion,
  evaluateCliVersion,
  parseCliVersion,
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
    expect(evaluateCliVersion('copilot_sdk', 'copilot-cli', '9.9.9', policy()).status).toBe('ok');
  });

  it('keeps the Copilot SDK driver off CLIs below its floor, which open in the CLI view', () => {
    expect(evaluateCliVersion('copilot_sdk', 'copilot-cli', '1.0.82').status).toBe('below_min');
    expect(evaluateCliVersion('copilot_sdk', 'copilot-cli', '1.0.83').status).toBe('below_min');
    expect(evaluateCliVersion('copilot_sdk', 'copilot-cli', '1.0.106-2').status).toBe('below_min');
    expect(evaluateCliVersion('copilot_sdk', 'copilot-cli', '1.0.113').status).toBe('ok');
    expect(evaluateCliVersion('copilot_sdk', 'copilot-cli', '1.0.114-0').status).toBe('untested');
    expect(evaluateCliVersion('copilot_sdk', 'copilot-cli', '1.0.114').status).toBe('untested');
    // The removed ACP driver's own range is gone with it (#2709); only the SDK's is checked.
    expect(TESTED_CLI_VERSIONS).not.toHaveProperty('copilot_acp');
  });

  describe('Codex against its tested range (#2699)', () => {
    const codex = (version: string | undefined, over?: CliVersionPolicy) => evaluateCliVersion('codex_app_server', 'codex-cli', version, over);
    const ranged: CliVersionPolicy = { tested: { codex_app_server: { minVersion: '0.160.0', testedMax: '0.166.0' } }, denylist: [] };

    it('is ok inside the range and at the top of it', () => {
      expect(codex('0.163.0', ranged)).toEqual({ status: 'ok', version: '0.163.0' });
      expect(codex('0.166.0', ranged)).toEqual({ status: 'ok', version: '0.166.0' });
      expect(codex('0.163.0')).toEqual({ status: 'ok', version: '0.163.0' });
      expect(codex(TESTED_CLI_VERSIONS.codex_app_server?.testedMax)).toMatchObject({ status: 'ok' });
    });

    it('is untested above the range', () => {
      expect(codex('0.166.1', ranged)).toMatchObject({
        status: 'untested',
        message: 'Codex 0.166.1 is newer than the version chat was tested with (0.166.0).',
      });
    });

    it('is below_min under a floor, and ok when the driver has no floor', () => {
      expect(codex('0.159.9', ranged)).toMatchObject({ status: 'below_min', version: '0.159.9' });
      expect(codex('0.1.0').status).toBe('ok');
    });

    it('gives no verdict on an unparseable version', () => {
      expect(codex('not-a-version', ranged)).toEqual({ status: 'unknown' });
      expect(codex(undefined, ranged)).toEqual({ status: 'unknown' });
    });
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

  it('matches exact denylist versions after normalizing', () => {
    const denylist = [{ provider: 'claude-code', versions: ['02.1.250+meta'], reason: 'r' }];
    expect(evaluateCliVersion('claude_agent_sdk', 'claude-code', '2.1.250 (Claude Code)', policy({ denylist })).status).toBe('known_bad');
  });
});

describe('shipped denylist', () => {
  it('is the only source: no remote list is read or saved (#3515)', () => {
    expect(getCliDenylist()).toEqual([]);
    expect(chatVersionPolicy).not.toHaveProperty('applyRemoteCliDenylist');
    expect(chatVersionPolicy).not.toHaveProperty('sanitizeDenylist');
  });
});

describe('Antigravity ACP version policy (#3800)', () => {
  const AGY = 'antigravity_acp' as Parameters<typeof evaluateCliVersion>[0];
  const live: CliVersionPolicy = { tested: TESTED_CLI_VERSIONS, denylist: [] };

  it('has a floor of 1.5.10 and no tested maximum, because nothing has run against a real agy yet', () => {
    expect(TESTED_CLI_VERSIONS[AGY]).toEqual({ minVersion: '1.5.10' });
  });

  it('refuses versions below the floor with the version and the floor, and no fallback instruction', () => {
    for (const v of ['1.5.0', '1.5.1', '1.5.8', '1.5.9', '1.4.12']) {
      const verdict = evaluateCliVersion(AGY, 'antigravity-cli', `agy ${v}`, live);
      expect(verdict.status, v).toBe('below_min');
      expect(verdict.message).toContain(`Antigravity CLI ${v}`);
      expect(verdict.message).toContain('1.5.10 or newer');
      expect(verdict.message).not.toMatch(/terminal|fall ?back/i);
    }
  });

  it('accepts the floor and anything newer without a note', () => {
    for (const v of ['1.5.10', '1.5.13', '1.6.0', '2.0.0']) expect(evaluateCliVersion(AGY, 'antigravity-cli', v, live)).toEqual({ status: 'ok', version: v });
  });

  it('gives no verdict for an unreported version', () => {
    expect(evaluateCliVersion(AGY, 'antigravity-cli', undefined, live)).toEqual({ status: 'unknown' });
    expect(evaluateCliVersion(AGY, 'antigravity-cli', 'agy dev build', live)).toEqual({ status: 'unknown' });
  });

  it('leaves the other drivers\' ranges as they were', () => {
    expect(TESTED_CLI_VERSIONS.claude_agent_sdk).toEqual({ testedMax: '2.1.316' });
    expect(TESTED_CLI_VERSIONS.claude_stream_json).toEqual({ testedMax: '2.1.316' });
    expect(TESTED_CLI_VERSIONS.codex_app_server).toEqual({ testedMax: '0.166.0' });
    expect(TESTED_CLI_VERSIONS.copilot_sdk).toEqual({ minVersion: '1.0.113', testedMax: '1.0.113' });
  });
});
