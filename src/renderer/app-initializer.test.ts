import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks (vi.mock factories are hoisted above imports) ────────────

const {
  mockLoadProjects,
  mockLoadNotificationSettings,
  mockLoadTheme,
  mockLoadOrchestratorSettings,
  mockLoadLoggingSettings,
  mockLoadHeadlessSettings,
  mockLoadBadgeSettings,
  mockLoadSessionSettings,
  mockLoadUpdateSettings,
  mockCheckWhatsNew,
  mockStartOnboarding,
  mockInitBadgeSideEffects,
  mockInitializePluginSystem,
} = vi.hoisted(() => ({
  mockLoadProjects: vi.fn().mockResolvedValue(undefined),
  mockLoadNotificationSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadTheme: vi.fn().mockResolvedValue(undefined),
  mockLoadOrchestratorSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadLoggingSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadHeadlessSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadBadgeSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadSessionSettings: vi.fn().mockResolvedValue(undefined),
  mockLoadUpdateSettings: vi.fn().mockResolvedValue(undefined),
  mockCheckWhatsNew: vi.fn(),
  mockStartOnboarding: vi.fn(),
  mockInitBadgeSideEffects: vi.fn(),
  mockInitializePluginSystem: vi.fn().mockResolvedValue(undefined),
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
    getState: vi.fn(() => ({ loadSettings: mockLoadOrchestratorSettings })),
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

let mockOnboardingCompleted = true;
vi.mock('./stores/onboardingStore', () => ({
  useOnboardingStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({
      completed: mockOnboardingCompleted,
      startOnboarding: mockStartOnboarding,
    })),
  }),
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
    mockOnboardingCompleted = true;
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

  it('should check What\'s New after 1s delay', () => {
    expect(mockCheckWhatsNew).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(mockCheckWhatsNew).toHaveBeenCalled();
  });

  it('should NOT start onboarding when already completed', () => {
    vi.advanceTimersByTime(1000);
    expect(mockStartOnboarding).not.toHaveBeenCalled();
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

describe('initApp – onboarding', () => {
  let cleanup: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockOnboardingCompleted = false;
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

  it('should start onboarding after 500ms when not completed', () => {
    expect(mockStartOnboarding).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(mockStartOnboarding).toHaveBeenCalled();
  });
});
