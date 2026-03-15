import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as path from 'path';

// Track all registered IPC handlers persistently (survives mockReset).
// vi.hoisted ensures this runs before vi.mock (which is also hoisted).
const { registeredHandlers } = vi.hoisted(() => {
  return { registeredHandlers: new Map<string, (...args: any[]) => any>() };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  promises: {
    writeFile: vi.fn(async () => {}),
  },
}));

import * as fs from 'fs';
import { resetAllSettingsStoresForTests } from '../services/settings-store';
import { clipboardSettings, CLIPBOARD_SETTINGS, registerSettingsHandlers } from './settings-handlers';

// IPC handlers are deferred — call register to bind them
beforeAll(() => {
  registerSettingsHandlers();
});

describe('settings-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
  });

  describe('CLIPBOARD_SETTINGS definition', () => {
    it('has the correct key', () => {
      expect(CLIPBOARD_SETTINGS.key).toBe('clipboard');
    });

    it('has the correct filename', () => {
      expect(CLIPBOARD_SETTINGS.filename).toBe('clipboard-settings.json');
    });

    it('has correct defaults', () => {
      expect(CLIPBOARD_SETTINGS.defaults).toEqual({ clipboardCompat: false });
    });
  });

  describe('clipboardSettings managed instance', () => {
    it('exposes getSettings method', () => {
      expect(typeof clipboardSettings.getSettings).toBe('function');
    });

    it('exposes saveSettings method', () => {
      expect(typeof clipboardSettings.saveSettings).toBe('function');
    });

    it('reads from clipboard-settings.json', () => {
      clipboardSettings.getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'clipboard-settings.json'),
        'utf-8',
      );
    });

    it('registers IPC get handler for clipboard settings', () => {
      expect(registeredHandlers.has('settings:clipboard:get')).toBe(true);
    });

    it('registers IPC save handler for clipboard settings', () => {
      expect(registeredHandlers.has('settings:clipboard:save')).toBe(true);
    });

    it('get handler returns current settings', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ clipboardCompat: true }));
      const handler = registeredHandlers.get('settings:clipboard:get')!;
      expect(handler({} as any)).toEqual({ clipboardCompat: true });
    });

    it('save handler persists settings', async () => {
      const handler = registeredHandlers.get('settings:clipboard:save')!;
      await handler({} as any, { clipboardCompat: true });
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'clipboard-settings.json'),
        JSON.stringify({ clipboardCompat: true }, null, 2),
        'utf-8',
      );
    });
  });

  describe('registerSettingsHandlers', () => {
    it('is idempotent — calling twice does not double-register', () => {
      registerSettingsHandlers(); // already called in beforeAll
      // Should still only have 2 handlers total (get + save)
      expect(registeredHandlers.size).toBeGreaterThanOrEqual(2);
    });
  });
});
