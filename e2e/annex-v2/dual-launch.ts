/**
 * Dual-launch harness for Annex V2 E2E tests.
 *
 * Launches two isolated Clubhouse Electron instances, each against its own
 * disposable profile, allowing end-to-end testing of the desktop-to-desktop
 * remote control protocol. Both go through the shared `launchApp` primitive,
 * so window selection, onboarding suppression and auto-update disabling match
 * single-instance launches.
 */
import type { Page } from '@playwright/test';
import { launchApp, type ElectronApp } from '../launch';
import type { DisposableProfile } from '../app-profile';
import { untrackOpenApp } from '../e2e-cleanup';

export interface InstanceHandle {
  electronApp: ElectronApp;
  window: Page;
  userDataDir: string;
  profile: DisposableProfile;
}

export interface DualInstanceHandles {
  satellite: InstanceHandle;
  controller: InstanceHandle;
}

/**
 * Launch a single Electron instance with its own disposable profile.
 */
async function launchInstance(label: string): Promise<InstanceHandle> {
  return launchApp({ label, args: ['--disable-gpu'] });
}

/**
 * Launch two isolated Clubhouse instances (satellite + controller).
 */
export async function launchDual(): Promise<DualInstanceHandles> {
  const [satellite, controller] = await Promise.allSettled([
    launchInstance('satellite'),
    launchInstance('controller'),
  ]);
  if (satellite.status === 'fulfilled' && controller.status === 'fulfilled') {
    return { satellite: satellite.value, controller: controller.value };
  }
  // One side failed — don't leak the side that came up.
  for (const result of [satellite, controller]) {
    if (result.status === 'fulfilled') await cleanupInstance(result.value);
  }
  throw satellite.status === 'rejected' ? satellite.reason : (controller as PromiseRejectedResult).reason;
}

/**
 * Clean up an instance: close the app and remove its profile.
 */
export async function cleanupInstance(handle: InstanceHandle): Promise<void> {
  try {
    await handle.electronApp.close();
  } catch {
    // App may have already exited
  }
  untrackOpenApp(handle.electronApp);
  handle.profile.dispose();
}

/**
 * Clean up both instances.
 */
export async function cleanupDual(handles: DualInstanceHandles): Promise<void> {
  await Promise.all([
    cleanupInstance(handles.satellite),
    cleanupInstance(handles.controller),
  ]);
}
