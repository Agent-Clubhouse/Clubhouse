/**
 * App wiring for Framebriar feedback: one FeedbackService, started with the app. It stays
 * idle until the user connects an invitation in Settings, Feedback; the Feedback button
 * appears only once capture is allowed. After quit begins nothing can start it again.
 */

import * as path from 'path';
import { app, net, safeStorage } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { appLog } from '../log-service';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { FeedbackService } from './feedback-service';
import { notifyFramebriarConnectionChanged, setFramebriarTelemetrySource } from '../../telemetry/destinations/framebriar-source';

let service: FeedbackService | null = null;
let quitting = false;

/** Feedback is always available until quit begins. */
export function isFeedbackEnabled(): boolean {
  return !quitting;
}

export function getFeedbackService(): FeedbackService {
  if (quitting) throw new Error('Clubhouse is quitting');
  if (!service) {
    const s = new FeedbackService({
      safeStorage,
      dataDir: path.join(app.getPath('userData'), 'framebriar'),
      appVersion: app.getVersion(),
      isOnline: () => net.isOnline(),
      log: (level, msg, meta) => appLog('core:feedback', level, msg, meta ? { meta } : undefined),
    });
    // The button, notices and Settings follow main's status in every window.
    s.onChange((status) => broadcastToAllWindows(IPC.FEEDBACK.STATUS_CHANGED, status));
    // Telemetry export to Framebriar follows Feedback's connection (spec §6.11).
    setFramebriarTelemetrySource(() => (service === s ? s.telemetryExport() : null));
    let wasConnected = false;
    s.onChange(() => {
      const now = s.telemetryConnected;
      if (now !== wasConnected) {
        wasConnected = now;
        notifyFramebriarConnectionChanged();
      }
    });
    service = s;
  }
  return service;
}

/** Called after the main window exists (app ready: Linux safeStorage backends load late). */
export function startFeedback(): void {
  if (!isFeedbackEnabled()) return;
  // telemetry-exempt: the service logs its own start failure; status shows it to the user.
  getFeedbackService().start().catch(() => {});
}

/** Stop the running service (one bounded flush; the outbox and enrollment stay on disk). */
async function stopService(): Promise<void> {
  const s = service;
  service = null;
  setFramebriarTelemetrySource(null);
  // Telemetry drops the Framebriar destination along with Feedback.
  if (s?.telemetryConnected) notifyFramebriarConnectionChanged();
  await s?.shutdown();
}

/** App quit: stop for good, so a late IPC call can't start a new service. */
export async function shutdownFeedback(): Promise<void> {
  quitting = true;
  await stopService();
}

/** For tests. */
export function resetFeedbackService(): void {
  service = null;
  quitting = false;
}
