/**
 * IPC for Framebriar screenshot feedback (src/main/services/framebriar). Everything is
 * gated on the experimental Feedback switch; with it off, status reports a stopped service
 * and every action is refused. The renderer is not a trust boundary: notes and scene are
 * untrusted text (the SDK also redacts and bounds them), and capture is always the calling
 * window's own contents, never the desktop.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { FeedbackSendInput, FeedbackStatus } from '../../shared/feedback-types';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { getFeedbackService, isFeedbackEnabled } from '../services/framebriar';
import { toFeedbackStatus } from '../services/framebriar/feedback-service';
import { objectArg, stringArg, withValidatedArgs } from './validation';

const MAX_NOTES = 4000;
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the renderer sees with the switch off. */
export function disabledFeedbackStatus(): FeedbackStatus {
  return toFeedbackStatus(
    false,
    { available: true },
    { state: 'disconnected', connected: false, enrolled: false, canCapture: false, notice: null, expiresAt: null },
    { state: 'checking', items: 0, bytes: 0, maxItems: 10, maxBytes: 32 * 1024 * 1024, blocked: 0, retention: 'until-delivered-or-cleared' },
    [],
  );
}

function requireEnabled(): void {
  if (!isFeedbackEnabled()) throw new Error('Feedback is turned off (Settings › Experimental › Feedback)');
}

export function validateSendInput(value: FeedbackSendInput, argName: string): void {
  const allowed = new Set(['draftId', 'notes', 'includeScreenshot', 'scene']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${argName}.${key} is not a recognized field`);
  }
  if (typeof value.notes !== 'string' || value.notes.length > MAX_NOTES) throw new Error(`${argName}.notes must be a string of at most ${MAX_NOTES} characters`);
  if (typeof value.includeScreenshot !== 'boolean') throw new Error(`${argName}.includeScreenshot must be a boolean`);
  if (value.draftId !== undefined && (typeof value.draftId !== 'string' || !DRAFT_ID.test(value.draftId))) throw new Error(`${argName}.draftId is invalid`);
  if (value.scene !== undefined && (typeof value.scene !== 'string' || value.scene.length > 40)) throw new Error(`${argName}.scene is invalid`);
}

let broadcasting = false;
/** Push status changes to every window (the button, notices and Settings follow them). */
function ensureBroadcast(): void {
  if (broadcasting) return;
  broadcasting = true;
  getFeedbackService().onChange((status) => broadcastToAllWindows(IPC.FEEDBACK.STATUS_CHANGED, status));
}

export function registerFeedbackHandlers(): void {
  ipcMain.handle(IPC.FEEDBACK.GET_STATUS, async () => {
    if (!isFeedbackEnabled()) return disabledFeedbackStatus();
    ensureBroadcast();
    const service = getFeedbackService();
    await service.start();
    return service.status();
  });

  ipcMain.handle(IPC.FEEDBACK.CONNECT, withValidatedArgs([stringArg({ maxLength: 256 })], async (_event, invitation) => {
    requireEnabled();
    ensureBroadcast();
    return getFeedbackService().connect(invitation);
  }));

  ipcMain.handle(IPC.FEEDBACK.DISCONNECT, async () => {
    requireEnabled();
    ensureBroadcast();
    return getFeedbackService().disconnect();
  });

  // Captures the window that asked, at the moment it asks (before its review dialog draws).
  ipcMain.handle(IPC.FEEDBACK.CAPTURE, async (event) => {
    requireEnabled();
    ensureBroadcast();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) throw new Error('No window to capture');
    return getFeedbackService().captureDraft(async () => (await win.webContents.capturePage()).toPNG());
  });

  ipcMain.handle(IPC.FEEDBACK.SEND, withValidatedArgs([objectArg<FeedbackSendInput>({ validate: validateSendInput })], async (_event, input) => {
    requireEnabled();
    ensureBroadcast();
    return getFeedbackService().send(input);
  }));

  ipcMain.handle(IPC.FEEDBACK.CANCEL, withValidatedArgs([stringArg({ maxLength: 64 })], (_event, draftId) => {
    if (isFeedbackEnabled()) getFeedbackService().cancel(draftId);
  }));
}
