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
import { useSessionSettingsStore } from './stores/sessionSettingsStore';
import { useOnboardingStore } from './stores/onboardingStore';
import { initializePluginSystem } from './plugins/plugin-loader';
import { rendererLog } from './plugins/renderer-logger';
import { useToastStore } from './stores/toastStore';
import { processResumeQueue } from './services/resume-queue';
import type { RestartSessionState } from '../shared/types';
import { initCanvasCommandHandler } from './features/assistant/canvas-command-handler';

// ─── Settings Loading ───────────────────────────────────────────────────────

async function loadAllSettings(): Promise<void> {
  // All store loads are independent — run them in parallel.
  await Promise.all([
    useProjectStore.getState().loadProjects(),
    useNotificationStore.getState().loadSettings(),
    useThemeStore.getState().loadTheme(),
    useOrchestratorStore.getState().loadSettings(),
    useLoggingStore.getState().loadSettings(),
    useHeadlessStore.getState().loadSettings(),
    useBadgeSettingsStore.getState().loadSettings(),
    useSessionSettingsStore.getState().loadSettings(),
    useUpdateStore.getState().loadSettings(),
  ]);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the application: load settings, start listeners, init plugins.
 * Returns a cleanup function that tears down listeners and timers.
 */
export async function initApp(): Promise<() => void> {
  const cleanups: (() => void)[] = [];

  // 1. Load all settings first — stores must be populated before anything
  //    that reads from them.
  await loadAllSettings();

  // 2. Initialize plugin system (must be after settings are loaded)
  try {
    await initializePluginSystem();
  } catch (err) {
    rendererLog('core:plugins', 'error', 'Failed to initialize plugin system', {
      meta: { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    });
    useToastStore.getState().addToast(
      'Failed to initialize plugin system. Some features may be unavailable.',
      'error',
    );
  }

  // 2b. Initialize canvas command handler for assistant MCP tools.
  //     Must be after plugin system so canvas store is available.
  const canvasCleanup = initCanvasCommandHandler();
  if (canvasCleanup) cleanups.push(canvasCleanup);

  // 3. Set up badge side effects AFTER settings are loaded, so subscriptions
  //    see the correct initial state.
  initBadgeSideEffects();

  // 4. Start IPC listeners for updates, annex, and plugin updates
  cleanups.push(initUpdateListener());
  cleanups.push(initAnnexListener());
  cleanups.push(initPluginUpdateListener());

  // 4b. Re-apply theme when the main process changes it (e.g. via assistant update_settings)
  cleanups.push(window.clubhouse.app.onThemeChanged(() => {
    useThemeStore.getState().loadTheme();
  }));

  // 5. Check for What's New dialog after startup (delayed)
  const whatsNewTimer = setTimeout(() => {
    useUpdateStore.getState().checkWhatsNew();
  }, 1000);
  cleanups.push(() => clearTimeout(whatsNewTimer));

  // 6. Show onboarding on first launch (delayed)
  if (!useOnboardingStore.getState().completed) {
    const onboardingTimer = setTimeout(() => {
      useOnboardingStore.getState().startOnboarding();
    }, 500);
    cleanups.push(() => clearTimeout(onboardingTimer));
  }

  // 7. Check for pending session resumes after an update restart
  window.clubhouse.app.getPendingResumes().then((state: unknown) => {
    if (state && typeof state === 'object' && 'sessions' in state) {
      const typed = state as RestartSessionState;
      if (typed.sessions.length > 0) {
        processResumeQueue(typed);
      }
    }
  }).catch((err: unknown) => {
    rendererLog('core:resume', 'error', 'Failed to check pending resumes', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
