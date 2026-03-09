import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// Mock electron before importing the module under test
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
}));

import { ipcMain } from 'electron';
import * as fs from 'fs';
import { createManagedSettings } from './managed-settings';
import type { SettingsDefinition } from '../../shared/settings-definitions';

interface TestSettings {
  enabled: boolean;
  name: string;
}

const TEST_DEF: SettingsDefinition<TestSettings> = {
  key: 'test',
  filename: 'test-settings.json',
  defaults: { enabled: false, name: 'default' },
};

describe('managed-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset readFileSync to throw ENOENT (file not found)
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
  });

  describe('createManagedSettings', () => {
    it('returns getSettings and saveSettings methods', () => {
      const managed = createManagedSettings(TEST_DEF);
      expect(typeof managed.getSettings).toBe('function');
      expect(typeof managed.saveSettings).toBe('function');
      expect(managed.store).toBeDefined();
    });

    it('registers get and save IPC handlers', () => {
      createManagedSettings(TEST_DEF);

      const handleCalls = vi.mocked(ipcMain.handle).mock.calls;
      const channels = handleCalls.map(([ch]) => ch);
      expect(channels).toContain('settings:test:get');
      expect(channels).toContain('settings:test:save');
    });

    it('get handler returns current settings', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true, name: 'saved' }));
      createManagedSettings(TEST_DEF);

      const getHandler = vi.mocked(ipcMain.handle).mock.calls.find(
        ([ch]) => ch === 'settings:test:get',
      )![1];

      const result = getHandler({} as any);
      expect(result).toEqual({ enabled: true, name: 'saved' });
    });

    it('get handler returns defaults when no file exists', () => {
      createManagedSettings(TEST_DEF);

      const getHandler = vi.mocked(ipcMain.handle).mock.calls.find(
        ([ch]) => ch === 'settings:test:get',
      )![1];

      expect(getHandler({} as any)).toEqual(TEST_DEF.defaults);
    });

    it('save handler persists settings', () => {
      createManagedSettings(TEST_DEF);

      const saveHandler = vi.mocked(ipcMain.handle).mock.calls.find(
        ([ch]) => ch === 'settings:test:save',
      )![1];

      const newSettings: TestSettings = { enabled: true, name: 'updated' };
      saveHandler({} as any, newSettings);

      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'test-settings.json'),
        JSON.stringify(newSettings, null, 2),
        'utf-8',
      );
    });

    it('getSettings reads from the correct file', () => {
      const managed = createManagedSettings(TEST_DEF);
      managed.getSettings();

      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'test-settings.json'),
        'utf-8',
      );
    });

    it('saveSettings persists to the correct file', () => {
      const managed = createManagedSettings(TEST_DEF);
      managed.saveSettings({ enabled: true, name: 'direct' });

      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'test-settings.json'),
        expect.any(String),
        'utf-8',
      );
    });
  });

  describe('onSave callback', () => {
    it('calls onSave after saving via IPC handler', () => {
      const onSave = vi.fn();
      createManagedSettings(TEST_DEF, { onSave });

      const saveHandler = vi.mocked(ipcMain.handle).mock.calls.find(
        ([ch]) => ch === 'settings:test:save',
      )![1];

      const newSettings: TestSettings = { enabled: true, name: 'callback' };
      saveHandler({} as any, newSettings);

      expect(onSave).toHaveBeenCalledWith(newSettings);
    });

    it('passes extra args to onSave', () => {
      const onSave = vi.fn();
      createManagedSettings(TEST_DEF, { onSave });

      const saveHandler = vi.mocked(ipcMain.handle).mock.calls.find(
        ([ch]) => ch === 'settings:test:save',
      )![1];

      const newSettings: TestSettings = { enabled: true, name: 'extra' };
      saveHandler({} as any, newSettings, '/some/path');

      expect(onSave).toHaveBeenCalledWith(newSettings, '/some/path');
    });

    it('does not call onSave when saving directly via saveSettings', () => {
      const onSave = vi.fn();
      const managed = createManagedSettings(TEST_DEF, { onSave });

      managed.saveSettings({ enabled: true, name: 'direct' });

      // onSave is only triggered via IPC, not direct calls
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe('defaultsOverride', () => {
    it('merges override with definition defaults', () => {
      const managed = createManagedSettings(TEST_DEF, {
        defaultsOverride: { enabled: true },
      });

      const result = managed.getSettings();
      expect(result.enabled).toBe(true);
      expect(result.name).toBe('default');
    });

    it('override values take precedence over definition defaults', () => {
      const managed = createManagedSettings(TEST_DEF, {
        defaultsOverride: { enabled: true, name: 'overridden' },
      });

      const result = managed.getSettings();
      expect(result).toEqual({ enabled: true, name: 'overridden' });
    });
  });

  describe('migrate option', () => {
    it('applies migration function when reading settings', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true, name: 'old', legacy: true }));

      const managed = createManagedSettings(TEST_DEF, {
        migrate: (raw) => ({
          enabled: raw.enabled as boolean,
          name: raw.legacy ? 'migrated' : (raw.name as string),
        }),
      });

      const result = managed.getSettings();
      expect(result.name).toBe('migrated');
    });
  });

  describe('store access', () => {
    it('exposes the underlying store for advanced operations', () => {
      const managed = createManagedSettings(TEST_DEF);
      expect(typeof managed.store.get).toBe('function');
      expect(typeof managed.store.save).toBe('function');
      expect(typeof managed.store.update).toBe('function');
    });

    it('store.update works for read-modify-write', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: false, name: 'original' }));

      const managed = createManagedSettings(TEST_DEF);
      const result = managed.store.update((current) => ({ ...current, enabled: true }));

      expect(result.enabled).toBe(true);
      expect(result.name).toBe('original');
    });
  });
});
