import { app, ipcMain, Menu, BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';

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
