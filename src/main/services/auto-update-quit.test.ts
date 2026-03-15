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

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  writeFile: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  access: vi.fn(async () => { throw new Error('ENOENT'); }),
  rm: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(async () => false),
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
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
    it('returns null when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      expect(await readPendingUpdateInfo()).toBeNull();
    });

    it('returns parsed info when file exists', async () => {
      const info = {
        version: '0.26.0',
        downloadPath: '/tmp/Clubhouse-0.26.0.zip',
        releaseNotes: 'Bug fixes',
        releaseMessage: 'Bug Fixes & More',
      };
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(info));
      expect(await readPendingUpdateInfo()).toEqual(info);
    });

    it('returns null when file contains invalid JSON', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('not json');
      expect(await readPendingUpdateInfo()).toBeNull();
    });
  });

  describe('writePendingUpdateInfo', () => {
    it('writes info as JSON to the correct path', async () => {
      const info = {
        version: '0.26.0',
        downloadPath: '/tmp/Clubhouse-0.26.0.zip',
        releaseNotes: 'Bug fixes',
        releaseMessage: null,
      };
      await writePendingUpdateInfo(info);

      expect(fsp.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('pending-update-info.json'),
        JSON.stringify(info),
        'utf-8',
      );
    });

    it('does not throw when write fails', async () => {
      vi.mocked(fsp.writeFile).mockRejectedValue(new Error('EPERM'));
      await expect(writePendingUpdateInfo({
        version: '0.26.0',
        downloadPath: '/tmp/x.zip',
        releaseNotes: null,
        releaseMessage: null,
      })).resolves.not.toThrow();
    });
  });

  describe('clearPendingUpdateInfo', () => {
    it('unlinks the pending info file', async () => {
      await clearPendingUpdateInfo();
      expect(fsp.unlink).toHaveBeenCalledWith(
        expect.stringContaining('pending-update-info.json'),
      );
    });

    it('does not throw when file does not exist', async () => {
      vi.mocked(fsp.unlink).mockRejectedValue(new Error('ENOENT'));
      await expect(clearPendingUpdateInfo()).resolves.not.toThrow();
    });
  });
});

describe('auto-update-service: applyUpdateOnQuit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when state is not ready', async () => {
    // Default state is idle
    const status = getStatus();
    expect(status.state).toBe('idle');

    // Should not throw and should not call any fs operations
    await applyUpdateOnQuit();
    expect(pathExists).not.toHaveBeenCalled();
  });

  it('is exported as a function', () => {
    expect(typeof applyUpdateOnQuit).toBe('function');
  });
});
