import type { App } from 'electron';

/** Keep background net requests from automatically disclosing OS identities. */
export function installClientCertificatePolicy(app: App): void {
  app.on('select-client-certificate', (event, webContents, _url, _certificates, callback) => {
    // Electron 44 added this event for net requests (webContents === null).
    // Previously those requests could not use a client certificate. Preserve
    // that boundary; retain Electron's existing behavior for browser windows.
    if (webContents === null) {
      event.preventDefault();
      callback();
    }
  });
}
