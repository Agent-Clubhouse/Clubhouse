import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_PROVIDER_IDS, PROVIDER_DESCRIPTORS, providerDescriptor, providerIdsWhere, providerTelemetryCode } from './descriptors';
import { accessLevelsFor } from '../agent-access';
import { AUTO_CANDIDATE_PROVIDERS, BUILTIN_PRESETS, PRESET_PROVIDERS, autoPolicySkip, autoPolicySkipFor, isLastResortProvider } from '../helper-routing';
import { AUTO_RESERVE_PROVIDERS, defaultAutoBudgetPolicy } from '../helper-auto-budget';
import { CAPACITY_PROVIDERS, parseHandoffCapacity } from '../handoff-capacity';
import { ATTR } from '../telemetry/attributes';

/**
 * Each former literal list, copied from 817ef3827 before #3787, and the value
 * the descriptors now give. A difference here is a behaviour change for an
 * existing provider.
 */
describe('descriptors reproduce the former lists exactly', () => {
  it('access levels per runtime (agent-access.ts LEVELS)', () => {
    const ALL = ['plan', 'ask', 'auto_edit', 'auto', 'full_access'];
    const former: Record<string, { chat: string[]; terminal: string[] }> = {
      'claude-code': { chat: ALL, terminal: ALL },
      'codex-cli': { chat: ALL, terminal: ['ask', 'auto', 'full_access'] },
      'copilot-cli': { chat: ['plan', 'ask', 'auto_edit', 'full_access'], terminal: ['ask', 'full_access'] },
    };
    for (const [id, row] of Object.entries(former)) {
      expect(accessLevelsFor(id, 'chat')).toEqual(row.chat);
      expect(accessLevelsFor(id, 'terminal')).toEqual(row.terminal);
    }
    expect(accessLevelsFor('antigravity-cli')).toEqual(['ask']);
    expect(accessLevelsFor(undefined, 'chat')).toEqual(['ask']);
  });

  it('helper routing lists and built-in presets (helper-routing.ts)', () => {
    expect(PRESET_PROVIDERS).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
    expect(AUTO_CANDIDATE_PROVIDERS).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
    expect(BUILTIN_PRESETS).toEqual({
      'claude-code': { easy: { model: 'haiku', effort: 'low' }, medium: { model: 'sonnet', effort: 'medium' }, hard: { model: 'opus', effort: 'high' } },
      'codex-cli': { easy: { model: 'gpt-6-luna', effort: 'low' }, medium: { model: 'gpt-6.1-terra', effort: 'medium' }, hard: { model: 'gpt-6.1-sol', effort: 'high' } },
      'copilot-cli': { easy: { model: 'claude-haiku-5.5', effort: 'low' }, medium: { model: 'claude-sonnet-5.5', effort: 'medium' }, hard: { model: 'claude-opus-5.5', effort: 'high' } },
    });
    // mobile-helper-routing.ts lastResortCandidates: ['copilot-cli'].
    expect(AUTO_CANDIDATE_PROVIDERS.filter(isLastResortProvider)).toEqual(['copilot-cli']);
  });

  it('Auto budget reserves (helper-auto-budget.ts)', () => {
    expect(AUTO_RESERVE_PROVIDERS).toEqual(['claude-code', 'codex-cli']);
    expect(defaultAutoBudgetPolicy()).toEqual({ version: 1, enabled: true, reserves: { 'claude-code': 10, 'codex-cli': 10 } });
  });

  it('handoff capacity keys (handoff-capacity.ts); peers check the set, not the order', () => {
    expect([...CAPACITY_PROVIDERS].sort()).toEqual(['claude-code', 'codex-cli', 'copilot-cli']);
    const parsed = parseHandoffCapacity({
      machine: Array(32).fill('ab').join(':'), online: true, sampledAt: 1, lastSeen: null,
      agents: { running: 0, sleeping: 0, idleDurable: 0 }, load: 'low', disk: 'ample',
      providers: { 'claude-code': 'available', 'copilot-cli': 'limited', 'codex-cli': 'unknown' }, accepting_handoffs: true,
    });
    expect(parsed.online && parsed.providers).toEqual({ 'claude-code': 'available', 'copilot-cli': 'limited', 'codex-cli': 'unknown' });
  });

  it('display strings per surface', () => {
    const d = PROVIDER_DESCRIPTORS;
    // orchestrator-colors.ts ORCHESTRATOR_DISPLAY_NAMES
    expect([d['claude-code'].displayName, d['copilot-cli'].displayName, d['codex-cli'].displayName]).toEqual(['Claude Code', 'GitHub Copilot', 'Codex']);
    // HelperPresetsSection.tsx PROVIDER_NAMES
    expect([d['claude-code'].shortName, d['codex-cli'].shortName, d['copilot-cli'].shortName]).toEqual(['Claude Code', 'Codex', 'Copilot']);
    // chat-version-policy.ts PROVIDER_LABELS
    expect([d['claude-code'].cliLabel, d['codex-cli'].cliLabel, d['copilot-cli'].cliLabel]).toEqual(['Claude Code', 'Codex', 'Copilot CLI']);
    // OrchestratorGlyph.tsx ORCH_GLYPH
    expect([d['claude-code'].glyph, d['codex-cli'].glyph, d['copilot-cli'].glyph]).toEqual(['C', 'X', 'G']);
    // orchestrator-colors.ts ORCHESTRATOR_COLORS
    expect([d['claude-code'].badgeColor, d['copilot-cli'].badgeColor, d['codex-cli'].badgeColor]).toEqual(['orange', 'blue', 'teal']);
    // SleepingAgent.tsx cliName
    expect([d['claude-code'].command, d['codex-cli'].command, d['copilot-cli'].command]).toEqual(['claude', 'codex', 'copilot']);
    // FirstRun.tsx INSTALL_URLS
    expect([d['claude-code'].install.docsUrl, d['codex-cli'].install.docsUrl, d['copilot-cli'].install.docsUrl]).toEqual([
      'https://docs.claude.com/en/docs/claude-code/setup', 'https://github.com/openai/codex', 'https://github.com/github/copilot-cli',
    ]);
  });

  it('state folders (provider-profiles-removed.ts STATE_DIR)', () => {
    expect(BUILTIN_PROVIDER_IDS.map((id) => PROVIDER_DESCRIPTORS[id].stateDir)).toEqual([
      { env: 'CLAUDE_CONFIG_DIR', fallback: '.claude' }, { env: 'CODEX_HOME', fallback: '.codex' }, { env: 'COPILOT_HOME', fallback: '.copilot' },
    ]);
  });

  it('telemetry codes stay closed (attributes.ts and the six knownCli checks)', () => {
    for (const id of ['claude-code', 'codex-cli', 'copilot-cli']) expect(providerTelemetryCode(id)).toBe(id);
    for (const id of ['antigravity-cli', '', null, undefined, '__proto__', 'toString']) expect(providerTelemetryCode(id)).toBe('other');
    expect(ATTR.orchestrator('claude-code').value).toBe('claude-code');
    expect(ATTR.orchestrator('antigravity-cli' as never).value).toBe('other');
    expect(ATTR.helperRoutingRequestedCli('auto').value).toBe('auto');
    expect(ATTR.helperAskerCli('none').value).toBe('none');
  });

  it('only own keys resolve', () => {
    expect(providerDescriptor('constructor')).toBeUndefined();
    expect(providerIdsWhere(() => true)).toEqual(BUILTIN_PROVIDER_IDS);
  });
});

describe('Auto policy (#3803)', () => {
  it.each([
    ['claude-code', undefined, undefined],
    ['codex-cli', undefined, undefined],
    // Copilot's copilotAuto reads as on unless saved off.
    ['copilot-cli', true, undefined],
    ['copilot-cli', false, 'auto_disabled'],
    ['antigravity-cli', true, 'auto_not_supported'],
  ] as const)('%s allowed=%s skips with %s', (id, allowed, skip) => {
    expect(autoPolicySkip(id, allowed)).toBe(skip);
  });

  it.each([
    ['candidate', undefined, undefined],
    ['candidate', true, undefined],
    ['candidate', false, 'auto_disabled'],
    ['opt_in', undefined, 'auto_disabled'],
    ['opt_in', false, 'auto_disabled'],
    ['opt_in', true, undefined],
    ['excluded', true, 'auto_not_supported'],
    ['excluded', undefined, 'auto_not_supported'],
    [undefined, true, 'auto_not_supported'],
  ] as const)('policy %s, allowed=%s skips with %s', (auto, allowed, skip) => {
    expect(autoPolicySkipFor(auto, allowed)).toBe(skip);
  });

  it('only an unknown-quota candidate ranks as a last resort', () => {
    expect(isLastResortProvider('copilot-cli')).toBe(true);
    expect(isLastResortProvider('claude-code')).toBe(false);
    expect(isLastResortProvider('codex-cli')).toBe(false);
    expect(isLastResortProvider('antigravity-cli')).toBe(false);
  });
});

/**
 * #3787 acceptance: no non-test file outside the provider descriptor and the
 * provider implementations lists every built-in provider id for policy or
 * display. A file that mentions each id for its own provider-specific
 * behaviour is not caught, because it doesn't mention all of them.
 */
describe('provider lists come from descriptors', () => {
  const root = path.resolve(__dirname, '../..');
  const EXEMPT_DIRS = ['main/orchestrators/', 'shared/providers/'];
  /** Files that may name every provider, and why. Keep this short. */
  const EXEMPT_FILES: Record<string, string> = {
    'renderer/features/agents/chat/fixtures/providers.ts': 'design-gallery fixtures, one sample session per provider',
    'renderer/features/agents/SleepingMascots.tsx': 'each drawing tags its own provider in data-mascot; selection uses the descriptor',
  };
  const isTest = (rel: string) => /\.(test|spec|qa)\.tsx?$|\.runtime\.qa\.ts$|(^|\/)__(tests|fixtures)__\//.test(rel);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('finds no new enumeration', () => {
    const offenders = walk(root)
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
      .filter((rel) => !isTest(rel) && !EXEMPT_DIRS.some((d) => rel.startsWith(d)) && !(rel in EXEMPT_FILES))
      .filter((rel) => {
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        return BUILTIN_PROVIDER_IDS.every((id) => text.includes(`'${id}'`) || text.includes(`"${id}"`));
      });
    expect(offenders).toEqual([]);
  });
});
