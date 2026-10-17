/**
 * App wiring for Framebriar feedback: one FeedbackService at a time, running only while
 * the experimental Feedback switch is on. Turning the switch off stops it (enrollment and
 * queued reports stay on disk); turning it on again starts a fresh one on first use.
 * After quit begins nothing can start it again.
 */

import * as path from 'path';
import { app, net, safeStorage } from 'electron';
import { FEEDBACK_EXPERIMENTAL_FLAG } from '../../../shared/feedback-types';
import { IPC } from '../../../shared/ipc-channels';
import * as experimentalSettings from '../experimental-settings';
import { isPreviewEligible } from '../preview-eligible';
import { appLog } from '../log-service';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { FeedbackService } from './feedback-service';

let service: FeedbackService | null = null;
let quitting = false;

/** Same gate as the other experimental features: the switch counts only in preview-eligible builds. */
export function isFeedbackEnabled(): boolean {
  return !quitting && isPreviewEligible() && experimentalSettings.getSettings()[FEEDBACK_EXPERIMENTAL_FLAG] === true;
}

export function getFeedbackService(): FeedbackService {
  if (quitting) throw new Error('Clubhouse is quitting');
  if (!service) {
    const s = new FeedbackService({
      safeStorage,
      dataDir: path.join(app.getPath('userData'), 'framebriar'),
      appVersion: app.getVersion(),
      isOnline: () => net.isOnline(),
    });
    // The button, notices and Settings follow main's status in every window.
    s.onChange((status) => broadcastToAllWindows(IPC.FEEDBACK.STATUS_CHANGED, status));
    service = s;
  }
  return service;
}

/** Called after the main window exists (app ready: Linux safeStorage backends load late). */
export function startFeedbackIfEnabled(): void {
  if (!isFeedbackEnabled()) return;
  getFeedbackService().start().catch((err) => {
    appLog('core:feedback', 'warn', 'Feedback start failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/** Stop the running service (one bounded flush; the outbox and enrollment stay on disk). */
async function stopService(): Promise<void> {
  const s = service;
  service = null;
  await s?.shutdown();
}

/**
 * The Experimental settings were saved: stop Feedback if its switch is now off. Turning it
 * on needs nothing here; the next status request starts it.
 */
export async function applyFeedbackSwitch(): Promise<void> {
  if (service && !isFeedbackEnabled()) {
    await stopService();
    // Windows drop the button and notices at once.
    broadcastToAllWindows(IPC.FEEDBACK.STATUS_CHANGED, null);
  }
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
