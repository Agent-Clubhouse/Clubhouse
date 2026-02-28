/**
 * App Initializer — one-time startup logic extracted from App.tsx.
 *
 * Loads settings, initializes the plugin system, sets up update/annex/
 * plugin-update listeners, and handles onboarding & "What's New" checks.
 *
 * All store access goes through `getState()` so none of these operations
 * create Zustand subscriptions in the React render cycle.
 *
 * Call `initApp()` once on mount; invoke the returned cleanup function on
 * unmount.
 */

import { useProjectStore } from './stores/projectStore';
import { useNotificationStore } from './stores/notificationStore';
import { useThemeStore } from './stores/themeStore';
import { useOrchestratorStore } from './stores/orchestratorStore';
import { useLoggingStore } from './stores/loggingStore';
import { useHeadlessStore } from './stores/headlessStore';
import { useBadgeSettingsStore } from './stores/badgeSettingsStore';
import { initBadgeSideEffects } from './stores/badgeStore';
import { useUpdateStore } from './stores/updateStore';
import { initUpdateListener } from './stores/updateStore';
import { initAnnexListener } from './stores/annexStore';
import { initPluginUpdateListener } from './stores/pluginUpdateStore';
import { useOnboardingStore } from './stores/onboardingStore';
import { initializePluginSystem } from './plugins/plugin-loader';

// ─── Settings Loading ───────────────────────────────────────────────────────

function loadAllSettings(): void {
  useProjectStore.getState().loadProjects();
  useNotificationStore.getState().loadSettings();
  useThemeStore.getState().loadTheme();
  useOrchestratorStore.getState().loadSettings();
  useLoggingStore.getState().loadSettings();
  useHeadlessStore.getState().loadSettings();
  useBadgeSettingsStore.getState().loadSettings();
  useUpdateStore.getState().loadSettings();
  initBadgeSideEffects();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the application: load settings, start listeners, init plugins.
 * Returns a cleanup function that tears down listeners and timers.
 */
export function initApp(): () => void {
  const cleanups: (() => void)[] = [];

  // 1. Load all settings BEFORE plugin system init (order matters)
  loadAllSettings();

  // 2. Initialize plugin system (must be after settings)
  initializePluginSystem().catch((err) => {
    console.error('[Plugins] Failed to initialize plugin system:', err);
  });

  // 3. Start IPC listeners for updates, annex, and plugin updates
  cleanups.push(initUpdateListener());
  cleanups.push(initAnnexListener());
  cleanups.push(initPluginUpdateListener());

  // 4. Check for What's New dialog after startup (delayed)
  const whatsNewTimer = setTimeout(() => {
    useUpdateStore.getState().checkWhatsNew();
  }, 1000);
  cleanups.push(() => clearTimeout(whatsNewTimer));

  // 5. Show onboarding on first launch (delayed)
  if (!useOnboardingStore.getState().completed) {
    const onboardingTimer = setTimeout(() => {
      useOnboardingStore.getState().startOnboarding();
    }, 500);
    cleanups.push(() => clearTimeout(onboardingTimer));
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
