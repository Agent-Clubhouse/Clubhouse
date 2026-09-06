import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'clubhouse-test-home')),
  },
  dialog: {
    showMessageBoxSync: vi.fn(),
  },
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fs from 'fs';
import { dialog } from 'electron';
import { appLog } from './log-service';
import {
  readMarker,
  writeMarker,
  clearMarker,
  shouldShowSafeModeDialog,
  incrementAttempt,
  handleSafeModeDialog,
} from './safe-mode';

const MARKER_PATH = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', '.startup-marker');

describe('safe-mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readMarker', () => {
    it('returns parsed marker when file exists', () => {
      const marker = { timestamp: 1000, attempt: 2, lastEnabledPlugins: ['a'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      expect(readMarker()).toEqual(marker);
    });

    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readMarker()).toBeNull();
    });

    it('returns null on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      expect(readMarker()).toBeNull();
    });
  });

  describe('writeMarker', () => {
    it('creates marker with attempt=1 when no existing marker', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      writeMarker(['plugin-a']);
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        MARKER_PATH,
        expect.any(String),
        expect.anything(),
      );
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.attempt).toBe(1);
      expect(written.lastEnabledPlugins).toEqual(['plugin-a']);
      expect(typeof written.timestamp).toBe('number');
    });

    it('increments attempt when existing marker exists', () => {
      const existing = { timestamp: 1000, attempt: 1, lastEnabledPlugins: ['old'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing));
      writeMarker(['new-plugin']);
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.attempt).toBe(2);
      expect(written.lastEnabledPlugins).toEqual(['new-plugin']);
    });
  });

  describe('clearMarker', () => {
    it('deletes the marker file', () => {
      clearMarker();
      expect(fs.unlinkSync).toHaveBeenCalledWith(MARKER_PATH);
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => clearMarker()).not.toThrow();
    });
  });

  describe('shouldShowSafeModeDialog', () => {
    it('returns false when no marker exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(shouldShowSafeModeDialog()).toBe(false);
    });

    it('returns false when attempt is 1', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: 1000, attempt: 1, lastEnabledPlugins: [] }),
      );
      expect(shouldShowSafeModeDialog()).toBe(false);
    });

    it('returns true when attempt is 2', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: 1000, attempt: 2, lastEnabledPlugins: ['a'] }),
      );
      expect(shouldShowSafeModeDialog()).toBe(true);
    });

    it('returns true when attempt is greater than 2', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: 1000, attempt: 5, lastEnabledPlugins: [] }),
      );
      expect(shouldShowSafeModeDialog()).toBe(true);
    });
  });

  describe('incrementAttempt', () => {
    it('calls writeMarker (alias)', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      incrementAttempt(['plugin-a']);
      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.attempt).toBe(1);
    });
  });

  describe('handleSafeModeDialog', () => {
    it('returns false when no marker exists (below-threshold case)', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = handleSafeModeDialog();
      expect(result).toBe(false);
      expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('shows dialog and returns true when user chooses safe mode', () => {
      const marker = { timestamp: 1000, attempt: 2, lastEnabledPlugins: ['plugin-a', 'plugin-b'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      vi.mocked(dialog.showMessageBoxSync).mockReturnValue(0);

      const result = handleSafeModeDialog();

      expect(result).toBe(true);
      expect(dialog.showMessageBoxSync).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          title: 'Clubhouse — Safe Mode',
          message: 'Clubhouse failed to start properly on the last attempt.',
          buttons: ['Start in Safe Mode', 'Try Again Normally'],
        }),
      );
      expect(fs.unlinkSync).toHaveBeenCalledWith(MARKER_PATH);
      expect(appLog).toHaveBeenNthCalledWith(
        2,
        'core:safe-mode',
        'warn',
        'User chose safe mode — disabling all plugins',
      );
    });

    it('shows dialog and returns false when user chooses to try again normally', () => {
      const marker = { timestamp: 1000, attempt: 2, lastEnabledPlugins: ['plugin-a'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      vi.mocked(dialog.showMessageBoxSync).mockReturnValue(1);

      const result = handleSafeModeDialog();

      expect(result).toBe(false);
      expect(dialog.showMessageBoxSync).toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('logs crash loop detection with marker details', () => {
      const marker = { timestamp: 1000, attempt: 3, lastEnabledPlugins: ['plugin-a', 'plugin-b', 'plugin-c'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      vi.mocked(dialog.showMessageBoxSync).mockReturnValue(1);

      handleSafeModeDialog();

      expect(appLog).toHaveBeenCalledWith(
        'core:safe-mode',
        'warn',
        'Startup crash loop detected, prompting safe mode',
        expect.objectContaining({
          meta: { attempt: 3, lastEnabledPlugins: ['plugin-a', 'plugin-b', 'plugin-c'] },
        }),
      );
    });

    it('includes plugin list in dialog message', () => {
      const marker = { timestamp: 1000, attempt: 2, lastEnabledPlugins: ['plugin-a', 'plugin-b'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      vi.mocked(dialog.showMessageBoxSync).mockReturnValue(1);

      handleSafeModeDialog();

      const dialogCall = vi.mocked(dialog.showMessageBoxSync).mock.calls[0][0];
      expect(dialogCall.detail).toContain('plugin-a, plugin-b');
    });

    it('uses "unknown" when lastEnabledPlugins is missing', () => {
      const marker = { timestamp: 1000, attempt: 2, lastEnabledPlugins: undefined };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      vi.mocked(dialog.showMessageBoxSync).mockReturnValue(1);

      handleSafeModeDialog();

      const dialogCall = vi.mocked(dialog.showMessageBoxSync).mock.calls[0][0];
      expect(dialogCall.detail).toContain('unknown');
    });

    it('clears marker only when user chooses safe mode (not on "try again")', () => {
      const marker = { timestamp: 1000, attempt: 2, lastEnabledPlugins: ['plugin-a'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      vi.mocked(dialog.showMessageBoxSync).mockReturnValue(1);

      handleSafeModeDialog();

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('safe-mode decision threshold (demonstrates regression test)', () => {
    it('demonstrates red test when threshold is inverted: threshold should be >= 2, not > 2', () => {
      const marker = { timestamp: 1000, attempt: 2, lastEnabledPlugins: ['a'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      expect(shouldShowSafeModeDialog()).toBe(true);
    });
  });
});

