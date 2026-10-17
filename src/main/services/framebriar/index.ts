/**
 * App wiring for Framebriar feedback: one FeedbackService per app run, started only when
 * the experimental Feedback switch is on, shut down on quit.
 */

import * as path from 'path';
import { app, net, safeStorage } from 'electron';
import { FEEDBACK_EXPERIMENTAL_FLAG } from '../../../shared/feedback-types';
import * as experimentalSettings from '../experimental-settings';
import { isPreviewEligible } from '../preview-eligible';
import { appLog } from '../log-service';
import { FeedbackService } from './feedback-service';

let service: FeedbackService | null = null;

/** Same gate as the other experimental features: the switch counts only in preview-eligible builds. */
export function isFeedbackEnabled(): boolean {
  return isPreviewEligible() && experimentalSettings.getSettings()[FEEDBACK_EXPERIMENTAL_FLAG] === true;
}

export function getFeedbackService(): FeedbackService {
  if (!service) {
    service = new FeedbackService({
      safeStorage,
      dataDir: path.join(app.getPath('userData'), 'framebriar'),
      appVersion: app.getVersion(),
      isOnline: () => net.isOnline(),
    });
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

/** One bounded flush; the outbox stays on disk for the next run. */
export async function shutdownFeedback(): Promise<void> {
  const s = service;
  service = null;
  await s?.shutdown();
}

/** For tests. */
export function resetFeedbackService(): void {
  service = null;
}
