import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock stores ────────────────────────────────────────────────────────────

const mockLoadProjects = vi.fn();
const mockLoadNotificationSettings = vi.fn();
const mockLoadTheme = vi.fn();
const mockLoadOrchestratorSettings = vi.fn();
const mockLoadLoggingSettings = vi.fn();
const mockLoadHeadlessSettings = vi.fn();
const mockLoadBadgeSettings = vi.fn();
const mockLoadUpdateSettings = vi.fn();
const mockCheckWhatsNew = vi.fn();
const mockStartOnboarding = vi.fn();

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

const mockInitBadgeSideEffects = vi.fn();
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

const mockInitializePluginSystem = vi.fn().mockResolvedValue(undefined);
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

  beforeEach(() => {
    vi.useFakeTimers();
    mockOnboardingCompleted = true;
    cleanup = initApp();
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
    expect(mockLoadUpdateSettings).toHaveBeenCalled();
  });

  it('should initialize badge side effects', () => {
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

describe('initApp – onboarding', () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mockOnboardingCompleted = false;
    cleanup = initApp();
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
