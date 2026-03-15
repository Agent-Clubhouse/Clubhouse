/**
 * Validates that the global electron mock provides all APIs used by production code.
 * This prevents tests from silently failing or needing local re-mocks.
 */
import { describe, it, expect } from 'vitest';
import { app, BrowserWindow, Notification, ipcMain, dialog, shell, nativeImage } from 'electron';

describe('global electron mock', () => {
  describe('app', () => {
    it('provides core app methods', () => {
      expect(app.getPath).toBeTypeOf('function');
      expect(app.getName).toBeTypeOf('function');
      expect(app.getVersion).toBeTypeOf('function');
      expect(app.on).toBeTypeOf('function');
      expect(app.isPackaged).toBe(false);
    });

    it('provides app.dock with setBadge and bounce', () => {
      expect(app.dock).toBeDefined();
      expect(app.dock.setBadge).toBeTypeOf('function');
      expect(app.dock.bounce).toBeTypeOf('function');
    });

    it('provides app.setBadgeCount', () => {
      expect(app.setBadgeCount).toBeTypeOf('function');
    });
  });

  describe('shell', () => {
    it('provides openExternal', () => {
      expect(shell.openExternal).toBeTypeOf('function');
    });

    it('provides showItemInFolder', () => {
      expect(shell.showItemInFolder).toBeTypeOf('function');
    });

    it('provides openPath', () => {
      expect(shell.openPath).toBeTypeOf('function');
    });
  });

  describe('nativeImage', () => {
    it('provides createFromPath returning a NativeImage-like stub', () => {
      expect(nativeImage.createFromPath).toBeTypeOf('function');
      const img = nativeImage.createFromPath('/fake/path');
      expect(img.isEmpty).toBeTypeOf('function');
      expect(img.isEmpty()).toBe(true);
    });

    it('provides createEmpty', () => {
      expect(nativeImage.createEmpty).toBeTypeOf('function');
    });
  });

  describe('BrowserWindow', () => {
    it('provides getAllWindows', () => {
      expect(BrowserWindow.getAllWindows).toBeTypeOf('function');
    });
  });

  describe('ipcMain', () => {
    it('provides handle, on, removeHandler', () => {
      expect(ipcMain.handle).toBeTypeOf('function');
      expect(ipcMain.on).toBeTypeOf('function');
      expect(ipcMain.removeHandler).toBeTypeOf('function');
    });
  });

  describe('dialog', () => {
    it('provides showOpenDialog and showSaveDialog', () => {
      expect(dialog.showOpenDialog).toBeTypeOf('function');
      expect(dialog.showSaveDialog).toBeTypeOf('function');
    });
  });

  describe('Notification', () => {
    it('can be constructed', () => {
      const n = new Notification({ title: 'test', body: 'body' });
      expect(n.title).toBe('test');
      expect(n.body).toBe('body');
    });

    it('provides isSupported', () => {
      expect(Notification.isSupported).toBeTypeOf('function');
    });
  });
});
