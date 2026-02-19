import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => key === 'userData' ? '/tmp/test-clubhouse' : '/tmp/test-temp',
    getVersion: () => '0.25.0',
    exit: vi.fn(),
    relaunch: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    createReadStream: actual.createReadStream,
    createWriteStream: actual.createWriteStream,
  };
});

import * as fs from 'fs';
import {
  readPendingUpdateInfo,
  writePendingUpdateInfo,
  clearPendingUpdateInfo,
  applyUpdateOnQuit,
  getStatus,
} from './auto-update-service';

describe('auto-update-service: pending update info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readPendingUpdateInfo', () => {
    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readPendingUpdateInfo()).toBeNull();
    });

    it('returns parsed info when file exists', () => {
      const info = {
        version: '0.26.0',
        downloadPath: '/tmp/Clubhouse-0.26.0.zip',
        releaseNotes: 'Bug fixes',
        releaseMessage: 'Bug Fixes & More',
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(info));
      expect(readPendingUpdateInfo()).toEqual(info);
    });

    it('returns null when file contains invalid JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json');
      expect(readPendingUpdateInfo()).toBeNull();
    });
  });

  describe('writePendingUpdateInfo', () => {
    it('writes info as JSON to the correct path', () => {
      const info = {
        version: '0.26.0',
        downloadPath: '/tmp/Clubhouse-0.26.0.zip',
        releaseNotes: 'Bug fixes',
        releaseMessage: null,
      };
      writePendingUpdateInfo(info);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('pending-update-info.json'),
        JSON.stringify(info),
        'utf-8',
      );
    });

    it('does not throw when write fails', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => { throw new Error('EPERM'); });
      expect(() => writePendingUpdateInfo({
        version: '0.26.0',
        downloadPath: '/tmp/x.zip',
        releaseNotes: null,
        releaseMessage: null,
      })).not.toThrow();
    });
  });

  describe('clearPendingUpdateInfo', () => {
    it('unlinks the pending info file', () => {
      clearPendingUpdateInfo();
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('pending-update-info.json'),
      );
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => clearPendingUpdateInfo()).not.toThrow();
    });
  });
});

describe('auto-update-service: applyUpdateOnQuit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when state is not ready', () => {
    // Default state is idle
    const status = getStatus();
    expect(status.state).toBe('idle');

    // Should not throw and should not call any fs operations
    applyUpdateOnQuit();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('is exported as a function', () => {
    expect(typeof applyUpdateOnQuit).toBe('function');
  });
});
