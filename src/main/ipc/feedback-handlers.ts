/**
 * IPC for Framebriar screenshot feedback (src/main/services/framebriar). Once quit begins,
 * status reports a stopped service and every action is refused. The renderer is not a trust boundary: only Clubhouse's own
 * windows may call (not webview-hosted plugin pages), notes and scene are untrusted text
 * (the SDK also redacts and bounds them), and capture is only ever Clubhouse's own
 * windows' contents (the caller first, then the other app windows), never the desktop.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { FEEDBACK_MAX_PNG_BYTES, type FeedbackSendInput } from '../../shared/feedback-types';
import { getFeedbackService, isFeedbackEnabled } from '../services/framebriar';
import { stoppedFeedbackStatus } from '../services/framebriar/feedback-service';
import { appLog } from '../services/log-service';
import { objectArg, stringArg, withValidatedArgs } from './validation';
import { findMainWindow, listPopoutWindows } from './window-handlers';
import type { CaptureSource } from '../services/framebriar/feedback-service';

const MAX_NOTES = 4000;
/** Base64 length of the largest PNG feedback sends (4 chars per 3 bytes, padded). */
const MAX_ANNOTATED_BASE64 = Math.ceil(FEEDBACK_MAX_PNG_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOT_ID = /^s\d{1,2}$/;

/**
 * Every Clubhouse window worth a screenshot (#2100): `first` (the window feedback started
 * from), then the main window and pop-outs. Hidden, minimized and closed windows are left out.
 */
export function captureSources(first: BrowserWindow | null): CaptureSource[] {
  const main = findMainWindow();
  const windows: Array<{ window: BrowserWindow; label: string }> = [
    ...(main ? [{ window: main, label: 'Main window' }] : []),
    ...listPopoutWindows(),
  ].filter((w) => !w.window.isDestroyed() && w.window.isVisible() && !w.window.isMinimized());
  if (first && !first.isDestroyed()) {
    const i = windows.findIndex((w) => w.window === first);
    const [entry] = i >= 0 ? windows.splice(i, 1) : [{ window: first, label: 'This window' }];
    windows.unshift(entry);
  }
  return windows.map(({ window, label }) => ({ label, grab: async () => (await window.webContents.capturePage()).toPNG() }));
}

/**
 * The keyboard shortcut (#2101): capture right away, from whichever Clubhouse window has
 * focus, then hand the draft to the main window's review dialog. Runs in main from the
 * menu accelerator, so no renderer sees a keydown first and hover states stay on screen.
 */
export async function captureFromShortcut(from?: BrowserWindow | null): Promise<void> {
  if (!isFeedbackEnabled()) return;
  const service = getFeedbackService();
  await service.start();
  if (!service.status().canCapture) {
    appLog('core:feedback', 'info', 'Feedback shortcut ignored: feedback is not set up');
    return;
  }
  const main = findMainWindow();
  if (!main || main.isDestroyed()) {
    // The review dialog lives in the main window (macOS keeps running with only a pop-out).
    appLog('core:feedback', 'info', 'Feedback shortcut ignored: no main window to review in');
    return;
  }
  const draft = await service.captureDraft(captureSources(from ?? BrowserWindow.getFocusedWindow()));
  if (main.isMinimized()) main.restore();
  main.focus();
  main.webContents.send(IPC.FEEDBACK.CAPTURED, draft);
}

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
  if (!isFeedbackEnabled()) throw new Error('Clubhouse is quitting');
  return win;
}

export function validateSendInput(value: FeedbackSendInput, argName: string): void {
  const allowed = new Set(['draftId', 'notes', 'includeScreenshot', 'scene', 'annotatedPng', 'shotId']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${argName}.${key} is not a recognized field`);
  }
  if (typeof value.notes !== 'string' || value.notes.length > MAX_NOTES) throw new Error(`${argName}.notes must be a string of at most ${MAX_NOTES} characters`);
  if (typeof value.includeScreenshot !== 'boolean') throw new Error(`${argName}.includeScreenshot must be a boolean`);
  if (value.draftId !== undefined && (typeof value.draftId !== 'string' || !DRAFT_ID.test(value.draftId))) throw new Error(`${argName}.draftId is invalid`);
  if (value.scene !== undefined && (typeof value.scene !== 'string' || value.scene.length > 40)) throw new Error(`${argName}.scene is invalid`);
  if (value.shotId !== undefined && (typeof value.shotId !== 'string' || !SHOT_ID.test(value.shotId))) throw new Error(`${argName}.shotId is invalid`);
  // Shape only here; the service decodes it and enforces the byte cap and dimensions.
  if (value.annotatedPng !== undefined && (typeof value.annotatedPng !== 'string' || value.annotatedPng.length > MAX_ANNOTATED_BASE64 || !BASE64.test(value.annotatedPng))) {
    throw new Error(`${argName}.annotatedPng must be base64 PNG data of at most ${FEEDBACK_MAX_PNG_BYTES} bytes`);
  }
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
    return getFeedbackService().captureDraft(captureSources(win));
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
