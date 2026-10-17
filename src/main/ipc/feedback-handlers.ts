/**
 * IPC for Framebriar screenshot feedback (src/main/services/framebriar). Everything is
 * gated on the experimental Feedback switch; with it off, status reports a stopped service
 * and every action is refused. The renderer is not a trust boundary: only Clubhouse's own
 * windows may call (not webview-hosted plugin pages), notes and scene are untrusted text
 * (the SDK also redacts and bounds them), and capture is always the calling window's own
 * contents, never the desktop.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { FeedbackSendInput } from '../../shared/feedback-types';
import { getFeedbackService, isFeedbackEnabled } from '../services/framebriar';
import { stoppedFeedbackStatus } from '../services/framebriar/feedback-service';
import { appLog } from '../services/log-service';
import { objectArg, stringArg, withValidatedArgs } from './validation';

const MAX_NOTES = 4000;
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The calling application window; webviews and other senders are refused. */
function callerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) {
    appLog('core:feedback', 'warn', 'Rejected feedback request: caller is not an application window');
    throw new Error('Feedback request rejected: unauthorized caller');
  }
  return win;
}

function requireEnabled(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const win = callerWindow(event);
  if (!isFeedbackEnabled()) throw new Error('Feedback is turned off (Settings › Experimental › Feedback)');
  return win;
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

export function registerFeedbackHandlers(): void {
  ipcMain.handle(IPC.FEEDBACK.GET_STATUS, async (event) => {
    callerWindow(event);
    if (!isFeedbackEnabled()) return stoppedFeedbackStatus();
    const service = getFeedbackService();
    await service.start();
    return service.status();
  });

  ipcMain.handle(IPC.FEEDBACK.CONNECT, withValidatedArgs([stringArg({ maxLength: 256 })], async (event, invitation) => {
    requireEnabled(event);
    return getFeedbackService().connect(invitation);
  }));

  ipcMain.handle(IPC.FEEDBACK.DISCONNECT, async (event) => {
    requireEnabled(event);
    return getFeedbackService().disconnect();
  });

  // Captures the window that asked, at the moment it asks (before its review dialog draws).
  ipcMain.handle(IPC.FEEDBACK.CAPTURE, async (event) => {
    const win = requireEnabled(event);
    return getFeedbackService().captureDraft(async () => (await win.webContents.capturePage()).toPNG());
  });

  ipcMain.handle(IPC.FEEDBACK.SEND, withValidatedArgs([objectArg<FeedbackSendInput>({ validate: validateSendInput })], async (event, input) => {
    requireEnabled(event);
    return getFeedbackService().send(input);
  }));

  ipcMain.handle(IPC.FEEDBACK.CANCEL, withValidatedArgs([stringArg({ maxLength: 64 })], (event, draftId) => {
    callerWindow(event);
    if (isFeedbackEnabled()) getFeedbackService().cancel(draftId);
  }));
}
