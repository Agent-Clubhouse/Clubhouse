/**
 * Custom protocol handler — Electron wiring.
 *
 * Registers the `clubhouse://` scheme with the OS, enforces a single app
 * instance (so links focus the running window instead of launching a second
 * copy), and routes activations to the renderer. The pure parsing/matching
 * logic lives in `../protocol-handler.ts`.
 *
 * Dispatch is resilient to cold starts: if a link launches the app, the
 * resolved action is queued until the renderer pulls it via
 * GET_PENDING_PROTOCOL_ACTION on mount. While the app is already running,
 * actions are pushed straight to the focused window via PROTOCOL_ACTION.
 */

import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { Project } from '../../shared/types';
import { appLog } from './log-service';
import {
  PROTOCOL_SCHEME,
  resolveProtocolUrl,
  extractProtocolUrlFromArgv,
  type ResolvedProtocolAction,
} from '../protocol-handler';

export interface ProtocolHandlerDeps {
  /** Returns the main window, or null if it isn't created yet. */
  getWindow: () => BrowserWindow | null;
  /** Returns the current project list (from the canonical project store). */
  listProjects: () => Promise<Project[]>;
}

/** Action queued before a window/renderer was ready to receive it. */
let pendingAction: ResolvedProtocolAction | null = null;

/**
 * Resolve a protocol URL and either push it to the running renderer or queue
 * it for the renderer to pull once ready. Exported for unit testing.
 */
export async function dispatchProtocolUrl(url: string, deps: ProtocolHandlerDeps): Promise<void> {
  let projects: Project[];
  try {
    projects = await deps.listProjects();
  } catch (err) {
    appLog('core:protocol', 'error', 'Failed to list projects for protocol dispatch', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    projects = [];
  }

  const action = resolveProtocolUrl(url, projects);
  if (!action) {
    appLog('core:protocol', 'warn', 'Ignoring unrecognized protocol URL', { meta: { url } });
    return;
  }

  appLog('core:protocol', 'info', `Protocol activation: ${action.kind}`, { meta: { url } });

  const win = deps.getWindow();
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    focusWindow(win);
    win.webContents.send(IPC.APP.PROTOCOL_ACTION, action);
    return;
  }

  // Window not ready yet (cold start). Queue for the renderer to pull. Focus
  // the window if it exists so the user lands on the app once it finishes load.
  pendingAction = action;
  if (win && !win.isDestroyed()) focusWindow(win);
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Return and clear any queued protocol action (renderer pulls this on mount). */
export function consumePendingProtocolAction(): ResolvedProtocolAction | null {
  const action = pendingAction;
  pendingAction = null;
  return action;
}

/** Test-only: reset module state between tests. */
export function _resetPendingProtocolActionForTests(): void {
  pendingAction = null;
}

/**
 * Register the protocol scheme and wire up the OS activation events. Call once
 * during app startup, before the `ready` event handler creates the window.
 *
 * Returns false if another instance already owns the single-instance lock —
 * the caller should quit in that case (the running instance handles the link).
 */
export function initProtocolHandler(deps: ProtocolHandlerDeps): boolean {
  registerScheme();

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // Another instance is running; it will receive our argv via second-instance.
    return false;
  }

  // Windows/Linux: a protocol link while running arrives as a new argv.
  app.on('second-instance', (_event, argv) => {
    const url = extractProtocolUrlFromArgv(argv);
    if (url) void dispatchProtocolUrl(url, deps);
    // Always surface the existing window even if the link was unrecognized.
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) focusWindow(win);
  });

  // macOS: protocol links arrive via open-url (running or cold start).
  app.on('open-url', (event, url) => {
    event.preventDefault();
    void dispatchProtocolUrl(url, deps);
  });

  // Windows/Linux cold start: the launching URL is in the initial argv.
  const initialUrl = extractProtocolUrlFromArgv(process.argv);
  if (initialUrl) void dispatchProtocolUrl(initialUrl, deps);

  return true;
}

function registerScheme(): void {
  // In development the app runs via the Electron binary, so the OS must be told
  // how to relaunch us with the right script path. Packaged builds register the
  // bundle directly.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }
}
