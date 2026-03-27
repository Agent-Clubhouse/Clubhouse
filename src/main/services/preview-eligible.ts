import { app } from 'electron';
import * as autoUpdateService from './auto-update-service';

/** Returns true when the build is a prerelease (beta, rc, etc.), user opted into preview channel, or running unpackaged (dev/test). */
export function isPreviewEligible(): boolean {
  if (!app.isPackaged) return true;
  const version = app.getVersion();
  if (/-(beta|rc|alpha|dev|canary)/.test(version)) return true;
  const updateSettings = autoUpdateService.getSettings();
  return !!updateSettings.previewChannel;
}
