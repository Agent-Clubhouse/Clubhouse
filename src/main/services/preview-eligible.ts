import { app } from 'electron';
import * as autoUpdateService from './auto-update-service';
import { appLog } from './log-service';

/** Returns true when the build is a prerelease (beta, rc, etc.), user opted into preview channel, or running unpackaged (dev/test). */
export function isPreviewEligible(): boolean {
  if (!app.isPackaged) {
    appLog('core:annex', 'debug', 'Preview eligible: unpackaged (dev) build');
    return true;
  }
  const version = app.getVersion();
  if (/-(beta|rc|alpha|dev|canary)/.test(version)) {
    appLog('core:annex', 'debug', `Preview eligible: prerelease version ${version}`);
    return true;
  }
  const updateSettings = autoUpdateService.getSettings();
  if (updateSettings.previewChannel) {
    appLog('core:annex', 'debug', 'Preview eligible: preview channel enabled');
    return true;
  }
  appLog('core:annex', 'debug', `Not preview eligible: packaged stable build v${version}, preview channel off`);
  return false;
}
