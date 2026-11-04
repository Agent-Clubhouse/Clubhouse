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
  // CLUBHOUSE_TEST_STABLE_BUILD: E2E only (e2e/stable-mode.spec.ts). An unpackaged
  // build follows the opt-in as a stable one does. Read here and nowhere else, so
  // a packaged build never looks at it.
  if (!app.isPackaged) return process.env.CLUBHOUSE_TEST_STABLE_BUILD === '1' ? getUpdateSettings().previewChannel : true;
  if (/-(beta|rc|alpha|dev|canary)/.test(app.getVersion())) return true;
  return getUpdateSettings().previewChannel;
}
