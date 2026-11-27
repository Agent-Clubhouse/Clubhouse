import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks (vi.mock factories are hoisted above imports) ────────────

const {
  mockLoadProjects,
  mockLoadNotificationSettings,
  mockLoadTheme,
  mockLoadOrchestratorSettings,
  mockCheckOrchestratorAvailability,
  mockOrchestratorAvailability,
  mockLoadLoggingSettings,
  mockLoadHeadlessSettings,
  mockLoadBadgeSettings,
  mockLoadSessionSettings,
  mockLoadUpdateSettings,
  mockCheckWhatsNew,
  mockCleanupRemovedOnboarding,
  mockInitBadgeSideEffects,
  mockInitializePluginSystem,
  mockStartWelcomeTour,
} = vi.hoisted(() => ({
  mockLoadProjects: vi.fn().mockResolvedValue(undefined),
  mockLoadNotificationSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadTheme: vi.fn().mockResolvedValue(undefined),
  mockLoadOrchestratorSettings: vi.fn().mockResolvedValue(undefined),
  mockCheckOrchestratorAvailability: vi.fn().mockResolvedValue(undefined),
  mockOrchestratorAvailability: {} as Record<string, { available: boolean; error?: string }>,
  mockLoadLoggingSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadHeadlessSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadBadgeSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadSessionSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadUpdateSettings: vi.fn().mockResolvedValue(undefined),
  mockCheckWhatsNew: vi.fn(),
  mockCleanupRemovedOnboarding: vi.fn(() => false),
  mockInitBadgeSideEffects: vi.fn(),
  mockInitializePluginSystem: vi.fn().mockResolvedValue(undefined),
  mockStartWelcomeTour: vi.fn().mockResolvedValue(false),
}));

vi.mock('./stores/projectStore', () => ({
  useProjectStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ loadProjects: mockLoadProjects })),
  }),
}));

vi.mock('./stores/notificationStore', () => ({
  useNotificationStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ loadSettings: mockLoadNotificationSettings })),
  }),
}));

vi.mock('./stores/themeStore', () => ({
  useThemeStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ loadTheme: mockLoadTheme })),
  }),
}));

vi.mock('./stores/orchestratorStore', () => ({
  useOrchestratorStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({
      loadSettings: mockLoadOrchestratorSettings,
      checkAllAvailability: mockCheckOrchestratorAvailability,
      availability: mockOrchestratorAvailability,
    })),
  }),
}));

vi.mock('./stores/loggingStore', () => ({
  useLoggingStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ loadSettings: mockLoadLoggingSettings })),
  }),
}));

vi.mock('./stores/headlessStore', () => ({
  useHeadlessStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ loadSettings: mockLoadHeadlessSettings })),
  }),
}));

vi.mock('./stores/badgeSettingsStore', () => ({
  useBadgeSettingsStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ loadSettings: mockLoadBadgeSettings })),
  }),
}));

vi.mock('./stores/sessionSettingsStore', () => ({
  useSessionSettingsStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({ loadSettings: mockLoadSessionSettings })),
  }),
}));

vi.mock('./stores/badgeStore', () => ({
  initBadgeSideEffects: mockInitBadgeSideEffects,
}));

vi.mock('./stores/updateStore', () => ({
  useUpdateStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({
      loadSettings: mockLoadUpdateSettings,
      checkWhatsNew: mockCheckWhatsNew,
    })),
  }),
  initUpdateListener: vi.fn(() => vi.fn()),
}));

vi.mock('./stores/annexStore', () => ({
  initAnnexListener: vi.fn(() => vi.fn()),
}));

vi.mock('./stores/pluginUpdateStore', () => ({
  initPluginUpdateListener: vi.fn(() => vi.fn()),
}));

// mockReset clears a mock's resolved value between tests, so an unset one means "not opened".
vi.mock('./features/welcome-tour/welcomeTourStore', () => ({
  startWelcomeTourIfDue: () => mockStartWelcomeTour() ?? Promise.resolve(false),
}));

vi.mock('./removed-onboarding-cleanup', () => ({
  cleanupRemovedOnboardingState: mockCleanupRemovedOnboarding,
}));

vi.mock('./plugins/plugin-loader', () => ({
  initializePluginSystem: mockInitializePluginSystem,
}));

import { initApp } from './app-initializer';
import { initUpdateListener } from './stores/updateStore';
import { initAnnexListener } from './stores/annexStore';
import { initPluginUpdateListener } from './stores/pluginUpdateStore';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('initApp', () => {
  let cleanup: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockCleanupRemovedOnboarding.mockClear();
    for (const key of Object.keys(mockOrchestratorAvailability)) {
      delete mockOrchestratorAvailability[key];
    }
    mockCheckOrchestratorAvailability.mockImplementation(async () => {
      mockOrchestratorAvailability['claude-code'] = { available: false, error: 'CLI not found' };
    });
    mockInitializePluginSystem.mockResolvedValue(undefined);
    (initUpdateListener as ReturnType<typeof vi.fn>).mockReturnValue(vi.fn());
    (initAnnexListener as ReturnType<typeof vi.fn>).mockReturnValue(vi.fn());
    (initPluginUpdateListener as ReturnType<typeof vi.fn>).mockReturnValue(vi.fn());
    (window.clubhouse.app.getPendingResumes as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    cleanup = await initApp();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('should load all settings', () => {
    expect(mockLoadProjects).toHaveBeenCalled();
    expect(mockLoadNotificationSettings).toHaveBeenCalled();
    expect(mockLoadTheme).toHaveBeenCalled();
    expect(mockLoadOrchestratorSettings).toHaveBeenCalled();
    expect(mockCheckOrchestratorAvailability).toHaveBeenCalled();
    expect(mockOrchestratorAvailability).toEqual({
      'claude-code': { available: false, error: 'CLI not found' },
    });
    expect(mockLoadLoggingSettings).toHaveBeenCalled();
    expect(mockLoadHeadlessSettings).toHaveBeenCalled();
    expect(mockLoadBadgeSettings).toHaveBeenCalled();
    expect(mockLoadSessionSettings).toHaveBeenCalled();
    expect(mockLoadUpdateSettings).toHaveBeenCalled();
  });

  it('should initialize badge side effects after settings load', () => {
    expect(mockInitBadgeSideEffects).toHaveBeenCalled();
  });

  it('should initialize plugin system after settings', () => {
    expect(mockInitializePluginSystem).toHaveBeenCalled();
  });

  it('should start update, annex, and plugin-update listeners', () => {
    expect(initUpdateListener).toHaveBeenCalled();
    expect(initAnnexListener).toHaveBeenCalled();
    expect(initPluginUpdateListener).toHaveBeenCalled();
  });

  it('should subscribe to theme changes from main process', () => {
    expect(window.clubhouse.app.onThemeChanged).toHaveBeenCalled();
  });

  it('should check What\'s New after 1s delay, when the welcome tour doesn\'t open', async () => {
    mockStartWelcomeTour.mockResolvedValueOnce(false);
    expect(mockCheckWhatsNew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockStartWelcomeTour).toHaveBeenCalledTimes(1);
    expect(mockCheckWhatsNew).toHaveBeenCalled();
  });

  it('leaves What\'s New for a later launch when the welcome tour opens (#2814)', async () => {
    mockStartWelcomeTour.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockStartWelcomeTour).toHaveBeenCalledTimes(1);
    expect(mockCheckWhatsNew).not.toHaveBeenCalled();
  });

  it('deletes the removed onboarding modal\'s saved state once per startup', () => {
    expect(mockCleanupRemovedOnboarding).toHaveBeenCalledTimes(1);
  });

  it('should return a cleanup function', () => {
    expect(typeof cleanup).toBe('function');
  });
});

describe('initApp – ordering', () => {
  it('should await settings before plugin system and badge side effects', async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];

    // Make settings load take time via a delayed promise
    mockLoadProjects.mockImplementation(() => {
      callOrder.push('loadProjects:start');
      return new Promise<void>((resolve) => {
        setTimeout(() => { callOrder.push('loadProjects:done'); resolve(); }, 100);
      });
    });
    mockInitializePluginSystem.mockImplementation(() => {
      callOrder.push('pluginSystem');
      return Promise.resolve();
    });
    mockInitBadgeSideEffects.mockImplementation(() => {
      callOrder.push('badgeSideEffects');
    });

    (initUpdateListener as ReturnType<typeof vi.fn>).mockReturnValue(vi.fn());
    (initAnnexListener as ReturnType<typeof vi.fn>).mockReturnValue(vi.fn());
    (initPluginUpdateListener as ReturnType<typeof vi.fn>).mockReturnValue(vi.fn());
    (window.clubhouse.app.getPendingResumes as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const initPromise = initApp();

    // Settings haven't resolved yet — plugin system should NOT have been called
    expect(callOrder).toContain('loadProjects:start');
    expect(callOrder).not.toContain('pluginSystem');
    expect(callOrder).not.toContain('badgeSideEffects');

    // Advance timers to let the delayed settings resolve
    await vi.advanceTimersByTimeAsync(100);
    await initPromise;

    // Now plugin system and badge side effects should have been called, in order
    const pluginIdx = callOrder.indexOf('pluginSystem');
    const badgeIdx = callOrder.indexOf('badgeSideEffects');
    const settingsDoneIdx = callOrder.indexOf('loadProjects:done');

    expect(settingsDoneIdx).toBeLessThan(pluginIdx);
    expect(pluginIdx).toBeLessThan(badgeIdx);

    (await initPromise)?.();
    vi.useRealTimers();
  });
});

describe('initApp – theme changes during startup', () => {
  it.each(['initial read', 'plugin startup', 'reconciliation'] as const)('applies the latest theme when it changes during %s', async (when) => {
    vi.useFakeTimers();
    let savedTheme = 'nord';
    let appliedTheme = '';
    let finishInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => { finishInitialRead = resolve; });
    const listeners = new Set<() => void>();
    const changeTheme = (id: string) => {
      savedTheme = id;
      for (const listener of listeners) listener();
    };
    vi.mocked(window.clubhouse.app.onThemeChanged).mockImplementation((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    let reads = 0;
    mockLoadTheme.mockImplementation(async () => {
      expect(listeners.size).toBe(1);
      const selected = savedTheme;
      reads += 1;
      if (reads === 1 && when === 'initial read') await initialRead;
      if (reads === 1 && when === 'reconciliation') changeTheme('dracula');
      if (reads === 2 && when === 'reconciliation') changeTheme('custom:latest');
      appliedTheme = selected;
    });
    mockInitializePluginSystem.mockImplementation(async () => {
      if (when === 'plugin startup') changeTheme('dracula');
    });
    vi.mocked(window.clubhouse.app.getPendingResumes).mockResolvedValue(null);
    const initializing = initApp();
    if (when === 'initial read') {
      changeTheme('dracula');
      finishInitialRead();
    }
    const cleanup = await initializing;
    try {
      expect(appliedTheme).toBe(when === 'reconciliation' ? 'custom:latest' : 'dracula');
      expect(reads).toBe(when === 'reconciliation' ? 3 : 2);
    } finally {
      cleanup();
      expect(listeners.size).toBe(0);
      vi.useRealTimers();
    }
  });
});
