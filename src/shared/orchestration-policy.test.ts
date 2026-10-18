import { describe, it, expect } from 'vitest';
import {
  ACCESS_LEVELS,
  ORCHESTRATION_DEFAULTS,
  accessLevelOf,
  applyOrchestrationPatch,
  checkHelperLimit,
  launchAccessFor,
  normalizeOrchestrationConfig,
  resolveHelperAccess,
  resolveOrchestrationPolicy,
  validateOrchestrationPatch,
  type OrchestrationAccess,
} from './orchestration-policy';
import type { FreeAgentPermissionMode } from './types';

describe('orchestration policy', () => {
  describe('defaults', () => {
    it('is off, same access, hands-off, five helpers', () => {
      expect(ORCHESTRATION_DEFAULTS).toEqual({ orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5 });
    });
  });

  describe('normalizeOrchestrationConfig', () => {
    it('keeps valid fields and drops the rest', () => {
      expect(normalizeOrchestrationConfig({
        orchestrate: true, access: 'root', control: 'ask-everything', maxHelpers: 0, extra: 1,
      })).toEqual({ orchestrate: true, control: 'ask-everything' });
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
    });

    it('throws on an invalid or unknown field', () => {
      expect(() => validateOrchestrationPatch({ access: 'root' })).toThrow(/access/);
      expect(() => validateOrchestrationPatch({ control: 'sometimes' })).toThrow(/control/);
      expect(() => validateOrchestrationPatch({ maxHelpers: 1000 })).toThrow(/maxHelpers/);
      expect(() => validateOrchestrationPatch({ orchestrate: 'yes' })).toThrow(/orchestrate/);
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
      expect(policy.sources).toEqual({ orchestrate: 'persona', access: 'default', control: 'agent', maxHelpers: 'persona' });
    });

    it('lets an agent turn off what its persona turns on', () => {
      expect(resolveOrchestrationPolicy({ orchestrate: false }, { orchestrate: true }).orchestrate).toBe(false);
    });

    it('ignores invalid stored values', () => {
      expect(resolveOrchestrationPolicy({ maxHelpers: -1 } as never, undefined).maxHelpers).toBe(5);
    });
  });

  describe('access levels', () => {
    it('reads the level from launch settings', () => {
      expect(accessLevelOf({ freeAgentMode: false, permissionMode: 'skip-all' })).toBe('standard');
      expect(accessLevelOf({ freeAgentMode: true, permissionMode: 'auto' })).toBe('auto');
      expect(accessLevelOf({ freeAgentMode: true, permissionMode: 'skip-all' })).toBe('bypass');
      expect(accessLevelOf({ freeAgentMode: true })).toBe('bypass');
    });

    it('round-trips every level through its launch settings', () => {
      for (const level of ACCESS_LEVELS) expect(accessLevelOf(launchAccessFor(level))).toBe(level);
    });
  });

  describe('resolveHelperAccess', () => {
    const orchestrators: Array<{ freeAgentMode: boolean; permissionMode?: FreeAgentPermissionMode }> = [
      { freeAgentMode: false },
      { freeAgentMode: false, permissionMode: 'skip-all' },
      { freeAgentMode: true, permissionMode: 'auto' },
      { freeAgentMode: true, permissionMode: 'skip-all' },
    ];
    const accesses: OrchestrationAccess[] = ['same', ...ACCESS_LEVELS];

    it('never gives a helper more access than its orchestrator', () => {
      for (const orchestrator of orchestrators) {
        const ceiling = ACCESS_LEVELS.indexOf(accessLevelOf(orchestrator));
        for (const access of accesses) {
          const helper = resolveHelperAccess(orchestrator, access);
          expect(ACCESS_LEVELS.indexOf(helper.level)).toBeLessThanOrEqual(ceiling);
          expect(ACCESS_LEVELS.indexOf(accessLevelOf(helper))).toBeLessThanOrEqual(ceiling);
        }
      }
    });

    it('carries bypass through with same', () => {
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'skip-all' }, 'same')).toEqual({
        freeAgentMode: true, permissionMode: 'skip-all', level: 'bypass', ceiling: 'bypass', clamped: false,
      });
    });

    it('gives a standard orchestrator standard helpers with same', () => {
      expect(resolveHelperAccess({ freeAgentMode: false }, 'same')).toEqual({
        freeAgentMode: false, level: 'standard', ceiling: 'standard', clamped: false,
      });
    });

    it('uses a fixed lower level', () => {
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'skip-all' }, 'auto')).toMatchObject({
        freeAgentMode: true, permissionMode: 'auto', level: 'auto', clamped: false,
      });
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'auto' }, 'standard')).toMatchObject({
        freeAgentMode: false, level: 'standard', clamped: false,
      });
    });

    it('lowers a fixed level above the orchestrator to its level', () => {
      expect(resolveHelperAccess({ freeAgentMode: false }, 'bypass')).toEqual({
        freeAgentMode: false, level: 'standard', ceiling: 'standard', clamped: true,
      });
      expect(resolveHelperAccess({ freeAgentMode: true, permissionMode: 'auto' }, 'bypass')).toMatchObject({
        permissionMode: 'auto', level: 'auto', clamped: true,
      });
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
