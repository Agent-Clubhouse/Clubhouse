import { app, Menu, BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { captureFromShortcut } from './ipc/feedback-handlers';
import { FEEDBACK_CAPTURE_MENU_ID } from './services/framebriar';
import { appLog } from './services/log-service';

/**
 * Feedback capture shortcut (#2101). Not Cmd/Ctrl+Alt+F: that is Monaco's Replace on
 * macOS, and a menu accelerator would take it from every editor.
 */
export const FEEDBACK_CAPTURE_ACCELERATOR = 'CmdOrCtrl+Shift+2';

export function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        {
          label: `About ${app.name}`,
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send(IPC.APP.OPEN_ABOUT);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Preferences…',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send(IPC.APP.OPEN_SETTINGS);
            }
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          id: FEEDBACK_CAPTURE_MENU_ID,
          label: 'Capture Feedback Screenshot',
          accelerator: FEEDBACK_CAPTURE_ACCELERATOR,
          // Off until feedback status says it can capture.
          enabled: false,
          click: (_item, win) => {
            // Electron passes the window whose menu fired (a BaseWindow); only a BrowserWindow can be captured.
            captureFromShortcut(win && 'webContents' in win ? (win as BrowserWindow) : null).catch((err: unknown) => {
              appLog('core:feedback', 'warn', 'Feedback shortcut capture failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
            });
          },
        },
      ],
    },
  ];

  // Dev-only Debug menu — never appears in packaged builds.
  // app.isPackaged is a built-in Electron property: false during
  // electron-forge start, true in production .app/.exe bundles.
  if (!app.isPackaged) {
    template.push({
      label: 'Debug',
      submenu: [
        {
          label: 'Simulate Update Restart',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            // Tell the renderer to open the Update Gate Modal in simulate mode.
            // The renderer listens for this event and drives the flow using
            // devSimulateUpdateRestart instead of confirmUpdateRestart.
            win.webContents.send(IPC.APP.DEV_SIMULATE_UPDATE_RESTART);
          },
        },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
