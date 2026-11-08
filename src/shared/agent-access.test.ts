import { describe, expect, it } from 'vitest';
import {
  ACCESS_LEVELS, ACCESS_DESCRIPTIONS, accessForLegacyToggle, accessFromLegacy, accessLabel, accessLevelsFor,
  isAccessLevel, legacyFreeAgentMode, legacyLaunchFor, savedAccess, startableAccess, withAccess,
} from './agent-access';

describe('agent access (#2761)', () => {
  describe('migration from Free Agent Mode', () => {
    it.each([
      [undefined, 'auto', 'ask'],
      [undefined, 'skip-all', 'ask'],
      [false, 'auto', 'ask'],
      [false, 'skip-all', 'ask'],
      [true, 'auto', 'auto'],
      [true, 'skip-all', 'full_access'],
      [true, undefined, 'auto'],
    ] as const)('freeAgentMode %s with mode %s becomes %s', (fam, mode, level) => {
      expect(accessFromLegacy(fam, mode)).toBe(level);
      // A saved agent without a level reads the same.
      expect(savedAccess({ freeAgentMode: fam }, mode)).toBe(level);
    });

    it('keeps the legacy flag derived from every level, nearest lower for the new ones', () => {
      expect(ACCESS_LEVELS.map((l) => [l, legacyFreeAgentMode(l)])).toEqual([
        ['plan', false], ['ask', false], ['auto_edit', false], ['auto', true], ['full_access', true],
      ]);
    });

    it('a level and its legacy pair round-trip for the three legacy levels', () => {
      for (const level of ['ask', 'auto', 'full_access'] as const) {
        const { freeAgentMode, permissionMode } = legacyLaunchFor(level);
        expect(accessFromLegacy(freeAgentMode, permissionMode)).toBe(level);
      }
    });

    it('keeps the old mode with Free Agent Mode off, so CLIs that read it start as before', () => {
      expect(legacyLaunchFor('ask', 'skip-all')).toEqual({ freeAgentMode: false, permissionMode: 'skip-all' });
      expect(legacyLaunchFor('plan', 'auto')).toEqual({ freeAgentMode: false, permissionMode: 'auto' });
      expect(legacyLaunchFor('full_access', 'auto')).toEqual({ freeAgentMode: true, permissionMode: 'skip-all' });
    });
  });

  describe('saved level against a later legacy write', () => {
    it('uses the saved level while the legacy flag agrees', () => {
      for (const level of ACCESS_LEVELS) {
        expect(savedAccess({ access: level, freeAgentMode: legacyFreeAgentMode(level) || undefined }, 'skip-all')).toBe(level);
      }
    });

    it('follows a legacy change made after it (an older phone or a rollback)', () => {
      expect(savedAccess({ access: 'plan', freeAgentMode: true }, 'auto')).toBe('auto');
      expect(savedAccess({ access: 'auto_edit', freeAgentMode: true }, 'skip-all')).toBe('full_access');
      expect(savedAccess({ access: 'full_access' }, 'skip-all')).toBe('ask');
      expect(savedAccess({ access: 'auto', freeAgentMode: false }, 'skip-all')).toBe('ask');
    });

    it('ignores a saved value that is not a level', () => {
      expect(savedAccess({ access: 'bypass', freeAgentMode: true }, 'skip-all')).toBe('full_access');
      expect(isAccessLevel('bypass')).toBe(false);
    });
  });

  describe('a legacy on/off request', () => {
    it('keeps a level already on the requested side', () => {
      expect(accessForLegacyToggle('plan', false, 'skip-all')).toBe('plan');
      expect(accessForLegacyToggle('auto_edit', false, 'skip-all')).toBe('auto_edit');
      expect(accessForLegacyToggle('auto', true, 'skip-all')).toBe('auto');
      expect(accessForLegacyToggle('full_access', true, 'auto')).toBe('full_access');
    });

    it('otherwise moves to the level the old setting gives', () => {
      expect(accessForLegacyToggle('ask', true, 'skip-all')).toBe('full_access');
      expect(accessForLegacyToggle('plan', true, 'auto')).toBe('auto');
      expect(accessForLegacyToggle('full_access', false, 'skip-all')).toBe('ask');
    });
  });

  describe('levels per CLI and runtime', () => {
    it('offers each runtime only the levels it can start at', () => {
      expect(accessLevelsFor('claude-code', 'terminal')).toEqual(ACCESS_LEVELS);
      expect(accessLevelsFor('codex-cli', 'terminal')).toEqual(['ask', 'auto', 'full_access']);
      expect(accessLevelsFor('copilot-cli', 'terminal')).toEqual(['ask', 'full_access']);
      expect(accessLevelsFor('copilot-cli', 'chat')).toEqual(['plan', 'ask', 'auto_edit', 'full_access']);
      expect(accessLevelsFor('codex-cli')).toEqual(ACCESS_LEVELS);
      expect(accessLevelsFor('unknown-cli')).toEqual(['ask']);
      expect(accessLevelsFor(undefined)).toEqual(['ask']);
    });

    it('starts at the nearest lower level a runtime has', () => {
      expect(startableAccess('auto_edit', 'codex-cli', 'terminal')).toBe('ask');
      expect(startableAccess('auto', 'copilot-cli', 'terminal')).toBe('ask');
      expect(startableAccess('auto', 'copilot-cli', 'chat')).toBe('auto_edit');
      expect(startableAccess('plan', 'codex-cli', 'terminal')).toBe('ask');
      expect(startableAccess('full_access', 'copilot-cli', 'terminal')).toBe('full_access');
    });
  });

  it('labels and describes every level, and never calls Auto safe', () => {
    expect(ACCESS_LEVELS.map(accessLabel)).toEqual(['Plan', 'Ask first', 'Auto-accept edits', 'Auto', 'Full access']);
    expect(ACCESS_DESCRIPTIONS.auto).toMatch(/can be wrong/);
    expect(ACCESS_DESCRIPTIONS.auto).not.toMatch(/safe/i);
  });

  describe('withAccess on template settings', () => {
    it('fills the level from a template saved before #2761, with the old mode', () => {
      expect(withAccess({ freeAgentMode: true }, 'skip-all')).toEqual({ freeAgentMode: true, access: 'full_access' });
      expect(withAccess({ freeAgentMode: true }, 'auto')).toEqual({ freeAgentMode: true, access: 'auto' });
      expect(withAccess({ freeAgentMode: false }, 'skip-all')).toEqual({ freeAgentMode: false, access: 'ask' });
    });

    it('derives the legacy flag from a level', () => {
      expect(withAccess({ access: 'auto_edit' }, 'skip-all')).toEqual({ access: 'auto_edit', freeAgentMode: false });
      expect(withAccess({ access: 'auto' }, 'skip-all')).toEqual({ access: 'auto', freeAgentMode: true });
    });

    it('leaves settings that set neither alone', () => {
      const s = { model: 'opus' } as { model: string; access?: undefined; freeAgentMode?: undefined };
      expect(withAccess(s, 'skip-all')).toBe(s);
    });
  });
});
