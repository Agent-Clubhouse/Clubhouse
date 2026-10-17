// Stub for electron module so main-process services can be imported in tests
import * as os from 'os';
import * as path from 'path';

export const app = {
  getPath: (name: string) => path.join(os.tmpdir(), `clubhouse-test-${name}`),
  isPackaged: false,
  getName: () => 'clubhouse-test',
  getVersion: () => '0.0.0-test',
  whenReady: () => Promise.resolve(),
  on: () => {},
  setBadgeCount: () => {},
  dock: {
    setBadge: () => {},
    bounce: () => -1,
  },
};

/** Reversible stand-in for OS-backed encryption; never use in production code. */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (plain: string) => Buffer.from(`test-enc:${plain}`, 'utf8'),
  decryptString: (buf: Buffer) => {
    const text = buf.toString('utf8');
    if (!text.startsWith('test-enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    return text.slice('test-enc:'.length);
  },
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

export const shell = {
  openExternal: async () => {},
  openPath: async () => ({ error: '' }),
  showItemInFolder: () => {},
};

export const nativeImage = {
  createFromPath: () => ({
    isEmpty: () => true,
    toDataURL: () => '',
    toPNG: () => Buffer.alloc(0),
    getSize: () => ({ width: 0, height: 0 }),
  }),
  createEmpty: () => ({
    isEmpty: () => true,
    toDataURL: () => '',
    toPNG: () => Buffer.alloc(0),
    getSize: () => ({ width: 0, height: 0 }),
  }),
};

export default { app, BrowserWindow, Notification, ipcMain, dialog, shell, nativeImage };
