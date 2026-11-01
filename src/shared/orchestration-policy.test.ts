import { describe, it, expect } from 'vitest';
import {
  ACCESS_LEVELS,
  ORCHESTRATION_DEFAULTS,
  accessLevelOf,
  applyOrchestrationPatch,
  checkHelperLimit,
  launchAccessFor,
  launchAccessForChatLevel,
  providerAccessLevel,
  rankHelperLaunch,
  normalizeOrchestrationConfig,
  resolveHelperAccess,
  resolveOrchestrationPolicy,
  validateOrchestrationPatch,
  type OrchestrationAccess,
} from './orchestration-policy';
import type { FreeAgentPermissionMode } from './types';

describe('orchestration policy', () => {
  describe('defaults', () => {
    it('is off, same access, hands-off, five helpers, no cross-project helpers', () => {
      expect(ORCHESTRATION_DEFAULTS).toEqual({ orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5, crossProjectHelpers: false, connectToDispatcher: false });
    });
  });

  describe('normalizeOrchestrationConfig', () => {
    it('keeps valid fields and drops the rest', () => {
      expect(normalizeOrchestrationConfig({
        orchestrate: true, access: 'root', control: 'ask-everything', maxHelpers: 0, extra: 1,
      })).toEqual({ orchestrate: true, control: 'ask-everything' });
    });

    it('keeps a boolean connectToDispatcher only (#2534)', () => {
      expect(normalizeOrchestrationConfig({ connectToDispatcher: true })).toEqual({ connectToDispatcher: true });
      expect(normalizeOrchestrationConfig({ connectToDispatcher: 'yes' })).toBeUndefined();
    });

    it('keeps a boolean crossProjectHelpers only', () => {
      expect(normalizeOrchestrationConfig({ crossProjectHelpers: true })).toEqual({ crossProjectHelpers: true });
      expect(normalizeOrchestrationConfig({ crossProjectHelpers: 'yes' })).toBeUndefined();
    });

    it('returns undefined for nothing valid', () => {
      expect(normalizeOrchestrationConfig(undefined)).toBeUndefined();
      expect(normalizeOrchestrationConfig('on')).toBeUndefined();
      expect(normalizeOrchestrationConfig([])).toBeUndefined();
      expect(normalizeOrchestrationConfig({ maxHelpers: 2.5 })).toBeUndefined();
    });
  });

  describe('validateOrchestrationPatch', () => {
    it('accepts valid fields and null resets', () => {
      expect(validateOrchestrationPatch({ orchestrate: true, access: 'auto', control: null, maxHelpers: 3 }))
        .toEqual({ orchestrate: true, access: 'auto', control: null, maxHelpers: 3 });
      expect(validateOrchestrationPatch({ crossProjectHelpers: true })).toEqual({ crossProjectHelpers: true });
      expect(validateOrchestrationPatch({ crossProjectHelpers: null })).toEqual({ crossProjectHelpers: null });
      expect(validateOrchestrationPatch({ connectToDispatcher: true })).toEqual({ connectToDispatcher: true });
      expect(validateOrchestrationPatch({ connectToDispatcher: null })).toEqual({ connectToDispatcher: null });
    });

    it('throws on an invalid or unknown field', () => {
      expect(() => validateOrchestrationPatch({ access: 'root' })).toThrow(/access/);
      expect(() => validateOrchestrationPatch({ control: 'sometimes' })).toThrow(/control/);
      expect(() => validateOrchestrationPatch({ maxHelpers: 1000 })).toThrow(/maxHelpers/);
      expect(() => validateOrchestrationPatch({ orchestrate: 'yes' })).toThrow(/orchestrate/);
      expect(() => validateOrchestrationPatch({ crossProjectHelpers: 1 })).toThrow(/crossProjectHelpers/);
      expect(() => validateOrchestrationPatch({ connectToDispatcher: 'on' })).toThrow(/connectToDispatcher/);
      expect(() => validateOrchestrationPatch({ bypass: true })).toThrow(/Unknown/);
      expect(() => validateOrchestrationPatch(null)).toThrow();
    });
  });

  describe('applyOrchestrationPatch', () => {
    it('sets and clears fields', () => {
      expect(applyOrchestrationPatch({ orchestrate: true, maxHelpers: 3 }, { maxHelpers: null, control: 'ask-before-start' }))
        .toEqual({ orchestrate: true, control: 'ask-before-start' });
    });

    it('returns undefined when everything is cleared', () => {
      expect(applyOrchestrationPatch({ orchestrate: true }, { orchestrate: null })).toBeUndefined();
    });
  });

  describe('resolveOrchestrationPolicy', () => {
    it('layers agent over persona over defaults and reports sources', () => {
      const policy = resolveOrchestrationPolicy({ control: 'ask-everything' }, { orchestrate: true, control: 'hands-off', maxHelpers: 2 });
      expect(policy).toMatchObject({ orchestrate: true, access: 'same', control: 'ask-everything', maxHelpers: 2 });
      expect(policy.sources).toEqual({
        orchestrate: 'persona', access: 'default', control: 'agent', maxHelpers: 'persona', crossProjectHelpers: 'default', connectToDispatcher: 'default',
      });
    });

    describe('connectToDispatcher (#2578)', () => {
      it('follows the resolved orchestrate while unset, with default as its source', () => {
        expect(resolveOrchestrationPolicy({ orchestrate: true }, undefined)).toMatchObject({ connectToDispatcher: true, sources: { connectToDispatcher: 'default' } });
        expect(resolveOrchestrationPolicy(undefined, { orchestrate: true })).toMatchObject({ connectToDispatcher: true, sources: { connectToDispatcher: 'default' } });
        expect(resolveOrchestrationPolicy({ orchestrate: false }, { orchestrate: true })).toMatchObject({ connectToDispatcher: false, sources: { connectToDispatcher: 'default' } });
        expect(resolveOrchestrationPolicy(undefined, undefined).connectToDispatcher).toBe(false);
      });

      it('lets an explicit value win over orchestrate, from the agent or its persona', () => {
        expect(resolveOrchestrationPolicy({ orchestrate: true, connectToDispatcher: false }, undefined)).toMatchObject({ connectToDispatcher: false, sources: { connectToDispatcher: 'agent' } });
        expect(resolveOrchestrationPolicy({ connectToDispatcher: true }, undefined)).toMatchObject({ orchestrate: false, connectToDispatcher: true, sources: { connectToDispatcher: 'agent' } });
        expect(resolveOrchestrationPolicy({ orchestrate: true }, { connectToDispatcher: false })).toMatchObject({ connectToDispatcher: false, sources: { connectToDispatcher: 'persona' } });
        expect(resolveOrchestrationPolicy({ connectToDispatcher: true }, { connectToDispatcher: false }).connectToDispatcher).toBe(true);
      });

      it('is always false on a helper, whatever is set, with default as its source', () => {
        const off = { connectToDispatcher: false, sources: { connectToDispatcher: 'default' } };
        expect(resolveOrchestrationPolicy(undefined, { orchestrate: true }, { helper: true })).toMatchObject({ orchestrate: true, ...off });
        expect(resolveOrchestrationPolicy({ connectToDispatcher: true }, undefined, { helper: true })).toMatchObject(off);
        expect(resolveOrchestrationPolicy(undefined, { connectToDispatcher: true }, { helper: true })).toMatchObject(off);
        expect(resolveOrchestrationPolicy({ connectToDispatcher: false }, undefined, { helper: true })).toMatchObject(off);
      });

      it('leaves a helper\'s other fields layered as usual', () => {
        const policy = resolveOrchestrationPolicy({ control: 'ask-everything' }, { maxHelpers: 2 }, { helper: true });
        expect(policy).toMatchObject({ control: 'ask-everything', maxHelpers: 2, sources: { control: 'agent', maxHelpers: 'persona' } });
      });
    });

    it('takes crossProjectHelpers from persona front-matter', () => {
      const policy = resolveOrchestrationPolicy(undefined, { orchestrate: true, crossProjectHelpers: true });
      expect(policy.crossProjectHelpers).toBe(true);
      expect(policy.sources.crossProjectHelpers).toBe('persona');
    });

    it('lets an agent turn off what its persona turns on', () => {
      expect(resolveOrchestrationPolicy({ orchestrate: false }, { orchestrate: true }).orchestrate).toBe(false);
    });

    it('ignores invalid stored values', () => {
      expect(resolveOrchestrationPolicy({ maxHelpers: -1 } as never, undefined).maxHelpers).toBe(5);
    });
  });

  describe('access levels', () => {
    it('reads the level from live launch settings, unknown as standard', () => {
      expect(accessLevelOf(undefined)).toBe('standard');
      expect(accessLevelOf({ freeAgentMode: false, permissionMode: 'skip-all' })).toBe('standard');
      expect(accessLevelOf({ freeAgentMode: true, permissionMode: 'auto' })).toBe('auto');
      expect(accessLevelOf({ freeAgentMode: true, permissionMode: 'skip-all' })).toBe('bypass');
      expect(accessLevelOf({ freeAgentMode: true })).toBe('standard');
    });

    it('pins an explicit permission mode for every level', () => {
      expect(launchAccessFor('standard')).toEqual({ freeAgentMode: false, permissionMode: 'auto' });
      expect(launchAccessFor('auto')).toEqual({ freeAgentMode: true, permissionMode: 'auto' });
      expect(launchAccessFor('bypass')).toEqual({ freeAgentMode: true, permissionMode: 'skip-all' });
      for (const level of ACCESS_LEVELS) expect(accessLevelOf(launchAccessFor(level))).toBe(level);
    });

    it('ranks each provider by its real flags', () => {
      for (const id of ['claude-code', 'codex-cli']) {
        expect(ACCESS_LEVELS.map((l) => providerAccessLevel(id, launchAccessFor(l)))).toEqual(['standard', 'auto', 'bypass']);
      }
      // Copilot: any Free Agent Mode is --yolo; skip-all without it is --allow-all-tools.
      expect(ACCESS_LEVELS.map((l) => providerAccessLevel('copilot-cli', launchAccessFor(l)))).toEqual(['standard', 'bypass', 'bypass']);
      expect(providerAccessLevel('copilot-cli', { freeAgentMode: false, permissionMode: 'skip-all' })).toBe('auto');
      expect(providerAccessLevel('someday-cli', launchAccessFor('auto'))).toBe('bypass');
    });

    it('maps chat levels to launch settings', () => {
      expect(accessLevelOf(launchAccessForChatLevel('plan'))).toBe('standard');
      expect(accessLevelOf(launchAccessForChatLevel('ask'))).toBe('standard');
      expect(accessLevelOf(launchAccessForChatLevel('auto_edit'))).toBe('standard');
      expect(accessLevelOf(launchAccessForChatLevel('auto'))).toBe('auto');
      expect(accessLevelOf(launchAccessForChatLevel('full_access'))).toBe('bypass');
    });
  });

  describe('resolveHelperAccess', () => {
    const orchestrators: Array<{ freeAgentMode: boolean; permissionMode?: FreeAgentPermissionMode } | undefined> = [
      undefined,
      { freeAgentMode: false },
      { freeAgentMode: false, permissionMode: 'skip-all' },
      { freeAgentMode: true },
      { freeAgentMode: true, permissionMode: 'auto' },
      { freeAgentMode: true, permissionMode: 'skip-all' },
    ];
    const accesses: OrchestrationAccess[] = ['same', ...ACCESS_LEVELS];
    const providers = ['claude-code', 'codex-cli', 'copilot-cli', undefined];

    it('never gives a helper flags above its orchestrator, on any provider', () => {
      for (const orchestrator of orchestrators) {
        const ceiling = ACCESS_LEVELS.indexOf(accessLevelOf(orchestrator));
        for (const access of accesses) {
          for (const provider of providers) {
            const helper = resolveHelperAccess(orchestrator, access, provider);
            expect(ACCESS_LEVELS.indexOf(helper.level)).toBeLessThanOrEqual(ceiling);
            expect(ACCESS_LEVELS.indexOf(providerAccessLevel(provider, helper))).toBeLessThanOrEqual(ceiling);
            expect(helper.permissionMode).toBeDefined();
          }
        }
      }
    });

    it('carries bypass through with same', () => {
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'skip-all' }, 'same', 'claude-code')).toMatchObject({
        freeAgentMode: true, permissionMode: 'skip-all', level: 'bypass', ceiling: 'bypass', clamped: false,
      });
    });

    it('starts standard helpers, with the mode pinned, for an orchestrator that is not running or has no known mode', () => {
      for (const live of [undefined, { freeAgentMode: true }]) {
        expect(resolveHelperAccess(live, 'same', 'copilot-cli')).toMatchObject({
          freeAgentMode: false, permissionMode: 'auto', level: 'standard', ceiling: 'standard',
        });
      }
    });

    it('uses a fixed lower level', () => {
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'skip-all' }, 'auto', 'claude-code')).toMatchObject({
        freeAgentMode: true, permissionMode: 'auto', level: 'auto', clamped: false,
      });
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'auto' }, 'standard', 'codex-cli')).toMatchObject({
        freeAgentMode: false, permissionMode: 'auto', level: 'standard', clamped: false,
      });
    });

    it('lowers a fixed level above the orchestrator to its level', () => {
      expect(resolveHelperAccess({ freeAgentMode: false, permissionMode: 'auto' }, 'bypass', 'claude-code')).toMatchObject({
        freeAgentMode: false, level: 'standard', ceiling: 'standard', clamped: true,
      });
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'auto' }, 'bypass', 'claude-code')).toMatchObject({
        permissionMode: 'auto', level: 'auto', clamped: true,
      });
    });

    it('starts a Copilot helper of an auto orchestrator standard, not --yolo', () => {
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'auto' }, 'same', 'copilot-cli')).toMatchObject({
        freeAgentMode: false, permissionMode: 'auto', level: 'standard', ceiling: 'auto', clamped: true,
      });
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'skip-all' }, 'same', 'copilot-cli').level).toBe('bypass');
    });
  });

  describe('checkHelperLimit', () => {
    it('allows a start under both limits', () => {
      expect(checkHelperLimit({ helperCount: 4, totalHelperCount: 19, maxHelpers: 5, globalCap: 20 }).ok).toBe(true);
    });

    it('refuses at the agent limit first', () => {
      const result = checkHelperLimit({ helperCount: 5, totalHelperCount: 20, maxHelpers: 5, globalCap: 20 });
      expect(result).toMatchObject({ ok: false, reason: 'agent-limit' });
    });

    it('refuses at the global cap', () => {
      const result = checkHelperLimit({ helperCount: 1, totalHelperCount: 20, maxHelpers: 5, globalCap: 20 });
      expect(result).toMatchObject({ ok: false, reason: 'global-cap' });
    });
  });
});

describe('rankHelperLaunch', () => {
  it('lowers to the requested access when it asks for less', () => {
    const launch = rankHelperLaunch(resolveHelperAccess(launchAccessFor('bypass'), 'same', 'claude-code'), 'auto', 'claude-code');
    expect(launch).toEqual({ freeAgentMode: true, permissionMode: 'auto', level: 'auto', clamped: false });
  });

  it('never raises above the policy resolution', () => {
    const launch = rankHelperLaunch(resolveHelperAccess(launchAccessFor('auto'), 'same', 'claude-code'), 'bypass', 'claude-code');
    expect(launch).toMatchObject({ freeAgentMode: true, permissionMode: 'auto', level: 'auto', clamped: true });
  });

  it('ignores an unknown requested level', () => {
    const launch = rankHelperLaunch(resolveHelperAccess(launchAccessFor('auto'), 'same', 'codex-cli'), 'root', 'codex-cli');
    expect(launch).toMatchObject({ level: 'auto', clamped: false });
  });

  it('ranks for the provider: Copilot under an Auto ceiling gets standard', () => {
    const launch = rankHelperLaunch(resolveHelperAccess(launchAccessFor('auto'), 'same', 'copilot-cli'), undefined, 'copilot-cli');
    expect(launch).toMatchObject({ freeAgentMode: false, permissionMode: 'auto', level: 'standard' });
  });
});
