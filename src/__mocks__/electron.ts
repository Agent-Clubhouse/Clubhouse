// Stub for electron module so main-process services can be imported in tests
export const app = {
  getPath: (name: string) => `/tmp/clubhouse-test-${name}`,
  isPackaged: false,
  getName: () => 'clubhouse-test',
  getVersion: () => '0.0.0-test',
  on: () => {},
};

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
};

export const Notification = class {
  title: string;
  body: string;
  constructor(opts: { title?: string; body?: string } = {}) {
    this.title = opts.title || '';
    this.body = opts.body || '';
  }
  show() {}
  static isSupported() {
    return false;
  }
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
};

export default { app, BrowserWindow, Notification, ipcMain, dialog };
