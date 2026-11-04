import { app } from 'electron';
import { getSettings as getUpdateSettings } from './update-settings';

/**
 * Returns true when the build is a prerelease (beta, rc, etc.), user opted into preview channel, or running unpackaged (dev/test).
 *
 * Every experimental flag read goes through this, including before `ready`
 * (initTelemetry), so it stays this small: nothing here needs the app ready, it
 * doesn't log, and it imports only the settings store.
 */
export function isPreviewEligible(): boolean {
  if (!app.isPackaged) return true;
  if (/-(beta|rc|alpha|dev|canary)/.test(app.getVersion())) return true;
  return getUpdateSettings().previewChannel;
}
