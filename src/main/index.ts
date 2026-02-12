import { app, BrowserWindow, Notification } from 'electron';
import { registerAllHandlers } from './ipc';
import { killAll } from './services/pty-manager';
import { buildMenu } from './menu';
import { getSettings as getThemeSettings } from './services/theme-service';

// Set the app name early so the dock, menu bar, and notifications all say "Clubhouse"
// instead of "Electron" during development.
app.name = 'Clubhouse';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (require('electron-squirrel-startup')) {
  app.quit();
}

const THEME_BG_COLORS: Record<string, string> = {
  'catppuccin-mocha': '#1e1e2e',
  'catppuccin-latte': '#eff1f5',
  'solarized-dark': '#002b36',
  'terminal': '#0a0a0a',
  'nord': '#2e3440',
  'dracula': '#282a36',
  'tokyo-night': '#1a1b26',
  'gruvbox-dark': '#282828',
};

function getThemeBgColor(): string {
  try {
    const { themeId } = getThemeSettings();
    return THEME_BG_COLORS[themeId] || '#1e1e2e';
  } catch {
    return '#1e1e2e';
  }
}

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

app.on('ready', () => {
  registerAllHandlers();
  buildMenu();
  createWindow();

  // Trigger macOS notification permission prompt on first launch.
  // Sending a notification is the only way to make macOS show the permission dialog.
  if (process.platform === 'darwin' && Notification.isSupported()) {
    new Notification({ title: 'Clubhouse', body: 'Notifications are enabled', silent: true }).show();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  killAll();
});
