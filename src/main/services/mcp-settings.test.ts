import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('./settings-store', () => {
  let defaults: Record<string, unknown> = {};
  let stored: Record<string, unknown> = {};
  return {
    createSettingsStore: vi.fn((_filename: string, initial: Record<string, unknown>) => {
      defaults = { ...initial };
      stored = { ...initial };
      return {
        get: () => ({ ...stored }),
        save: vi.fn(async (settings: Record<string, unknown>) => { stored = { ...settings }; }),
      };
    }),
    resetAllSettingsStoresForTests: vi.fn(() => { stored = { ...defaults }; }),
  };
});

let cmStored: { enabled: boolean; projectOverrides?: Record<string, boolean> } = { enabled: false };

vi.mock('./clubhouse-mode-settings', () => ({
  isClubhouseModeEnabled: vi.fn(() => false),
  getSettings: vi.fn(() => ({ ...cmStored })),
}));

let dispatcherOn = false;
vi.mock('./dispatcher/dispatcher-settings', () => ({
  isDispatcherEnabled: vi.fn(() => dispatcherOn),
}));

import { isMcpEnabled, isMcpEnabledForAny, notifyMcpEnablementChanged, onMcpEnablementChanged, saveSettings } from './mcp-settings';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import { resetAllSettingsStoresForTests } from './settings-store';

describe('mcp-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
    cmStored = { enabled: false };
    dispatcherOn = false;
  });

  describe('isMcpEnabled', () => {
    it('returns true using the shared default', () => {
      expect(isMcpEnabled()).toBe(true);
    });

    it('returns true when globally enabled', async () => {
      await saveSettings({ enabled: true });
      expect(isMcpEnabled()).toBe(true);
    });

    it('agent override takes highest priority', async () => {
      await saveSettings({ enabled: false });
      expect(isMcpEnabled('/project', true)).toBe(true);
      expect(isMcpEnabled('/project', false)).toBe(false);
    });

    it('project override takes priority over global', async () => {
      await saveSettings({ enabled: true, projectOverrides: { '/project': false } });
      expect(isMcpEnabled('/project')).toBe(false);
    });

    it('falls back to clubhouse mode when all disabled', async () => {
      await saveSettings({ enabled: false });
      vi.mocked(isClubhouseModeEnabled).mockReturnValue(true);
      expect(isMcpEnabled()).toBe(true);
    });

    // Precedence: agent > project > global (> Clubhouse mode). #2223
    it.each([
      // [case, global, project override, agent override, expected]
      ['global on', true, undefined, undefined, true],
      ['global off', false, undefined, undefined, false],
      ['project on beats global off', false, true, undefined, true],
      ['project off beats global on', true, false, undefined, false],
      ['agent off beats global on', true, undefined, false, false],
      ['agent off beats project on', false, true, false, false],
      ['agent off beats global and project on', true, true, false, false],
      ['agent on beats global off', false, undefined, true, true],
      ['agent on beats project off', true, false, true, true],
      ['agent on beats global and project off', false, false, true, true],
    ] as const)('precedence: %s', async (_case, enabled, project, agent, expected) => {
      vi.mocked(isClubhouseModeEnabled).mockReturnValue(false);
      await saveSettings({ enabled, ...(project === undefined ? {} : { projectOverrides: { '/project': project } }) });
      expect(isMcpEnabled('/project', agent)).toBe(expected);
    });

    it('an agent turned off stays off even when Clubhouse mode is on', async () => {
      await saveSettings({ enabled: false });
      vi.mocked(isClubhouseModeEnabled).mockReturnValue(true);
      expect(isMcpEnabled('/project', false)).toBe(false);
      expect(isMcpEnabled('/project')).toBe(true);
    });

    it('clubhouse mode fallback receives project path', async () => {
      await saveSettings({ enabled: false });
      vi.mocked(isClubhouseModeEnabled).mockReturnValue(false);
      isMcpEnabled('/my-project');
      expect(isClubhouseModeEnabled).toHaveBeenCalledWith('/my-project');
    });
  });

  describe('isMcpEnabledForAny', () => {
    it('returns true by default', () => {
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns false when everything is disabled', async () => {
      await saveSettings({ enabled: false });
      expect(isMcpEnabledForAny()).toBe(false);
    });

    it('returns true when MCP global toggle is on', async () => {
      await saveSettings({ enabled: true });
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns true when any MCP project override is true', async () => {
      await saveSettings({ enabled: false, projectOverrides: { '/a': false, '/b': true } });
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns false when all MCP project overrides are false', async () => {
      await saveSettings({ enabled: false, projectOverrides: { '/a': false, '/b': false } });
      expect(isMcpEnabledForAny()).toBe(false);
    });

    it('returns true when Clubhouse Mode global toggle is on', async () => {
      await saveSettings({ enabled: false });
      cmStored = { enabled: true };
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns true when any Clubhouse Mode project override is true', async () => {
      await saveSettings({ enabled: false });
      cmStored = { enabled: false, projectOverrides: { '/x': false, '/y': true } };
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns true while the Dispatcher is on, with everything else off (#2535)', async () => {
      await saveSettings({ enabled: false });
      expect(isMcpEnabledForAny()).toBe(false);
      dispatcherOn = true;
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('lets the Dispatcher\'s mcpOverride turn MCP on for its folder', async () => {
      await saveSettings({ enabled: false });
      expect(isMcpEnabled('/dispatcher')).toBe(false);
      expect(isMcpEnabled('/dispatcher', true)).toBe(true);
    });

    it('returns false when all Clubhouse Mode project overrides are false', async () => {
      await saveSettings({ enabled: false });
      cmStored = { enabled: false, projectOverrides: { '/x': false } };
      expect(isMcpEnabledForAny()).toBe(false);
    });
  });
});

describe('onMcpEnablementChanged (#2589)', () => {
  it('tells every listener, past one that throws, until unsubscribed', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    const offBad = onMcpEnablementChanged(bad);
    const offGood = onMcpEnablementChanged(good);
    notifyMcpEnablementChanged();
    expect(good).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
    notifyMcpEnablementChanged();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
