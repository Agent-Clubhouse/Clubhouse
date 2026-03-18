import { app, Menu, BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';

function sendEditCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow();
  if (win) {
    win.webContents.send(IPC.APP.EDIT_COMMAND, command);
  }
}

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
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendEditCommand('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendEditCommand('redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => sendEditCommand('cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendEditCommand('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendEditCommand('paste') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendEditCommand('selectAll') },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
