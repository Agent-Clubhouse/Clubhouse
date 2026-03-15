import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
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
import {
  writeApplyAttempt,
  readApplyAttempt,
  clearApplyAttempt,
  getPendingReleaseNotes,
  clearPendingReleaseNotes,
  dismissUpdate,
  getStatus,
} from './auto-update-service';

// ---------------------------------------------------------------------------
// Apply attempt persistence
// ---------------------------------------------------------------------------

describe('apply attempt persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('writeApplyAttempt', () => {
    it('writes attempt as JSON to the correct path', async () => {
      const attempt = { version: '0.30.0', artifactUrl: 'https://example.com/a.zip', attemptedAt: '2026-01-01T00:00:00Z' };
      await writeApplyAttempt(attempt);
      // Find the call that wrote to the apply-attempt file
      const calls = vi.mocked(fsp.writeFile).mock.calls;
      const call = calls.find((c) => String(c[0]).includes('update-apply-attempt.json'));
      expect(call).toBeDefined();
      expect(call![1]).toBe(JSON.stringify(attempt));
    });

    it('does not throw on write failure', async () => {
      vi.mocked(fsp.writeFile).mockRejectedValue(new Error('EPERM'));
      await expect(writeApplyAttempt({
        version: '0.30.0', artifactUrl: null, attemptedAt: '2026-01-01T00:00:00Z',
      })).resolves.not.toThrow();
    });
  });

  describe('readApplyAttempt', () => {
    it('returns null when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      expect(await readApplyAttempt()).toBeNull();
    });

    it('returns parsed attempt when file exists', async () => {
      const attempt = { version: '0.30.0', artifactUrl: 'https://example.com/a.zip', attemptedAt: '2026-01-01T00:00:00Z' };
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(attempt));
      expect(await readApplyAttempt()).toEqual(attempt);
    });

    it('returns null on invalid JSON', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('not json');
      expect(await readApplyAttempt()).toBeNull();
    });
  });

  describe('clearApplyAttempt', () => {
    it('unlinks the attempt file', async () => {
      await clearApplyAttempt();
      expect(fsp.unlink).toHaveBeenCalledWith(
        expect.stringContaining('update-apply-attempt.json'),
      );
    });

    it('does not throw when file does not exist', async () => {
      vi.mocked(fsp.unlink).mockRejectedValue(new Error('ENOENT'));
      await expect(clearApplyAttempt()).resolves.not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Pending release notes persistence
// ---------------------------------------------------------------------------

describe('pending release notes persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPendingReleaseNotes', () => {
    it('returns null when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      expect(await getPendingReleaseNotes()).toBeNull();
    });

    it('returns parsed notes when file exists', async () => {
      const notes = { version: '0.30.0', releaseNotes: '## Bug fixes\n- Fixed a bug' };
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(notes));
      expect(await getPendingReleaseNotes()).toEqual(notes);
    });

    it('returns null on invalid JSON', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{bad');
      expect(await getPendingReleaseNotes()).toBeNull();
    });
  });

  describe('clearPendingReleaseNotes', () => {
    it('unlinks the notes file', async () => {
      await clearPendingReleaseNotes();
      expect(fsp.unlink).toHaveBeenCalledWith(
        expect.stringContaining('pending-release-notes.json'),
      );
    });

    it('does not throw when file does not exist', async () => {
      vi.mocked(fsp.unlink).mockRejectedValue(new Error('ENOENT'));
      await expect(clearPendingReleaseNotes()).resolves.not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// getStatus / dismissUpdate
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('returns a copy of the current status', () => {
    const s1 = getStatus();
    const s2 = getStatus();
    expect(s1).toEqual(s2);
    expect(s1).not.toBe(s2); // must be a copy
  });

  it('has the expected default shape', () => {
    const s = getStatus();
    expect(s).toMatchObject({
      state: expect.any(String),
      downloadProgress: expect.any(Number),
      applyAttempted: expect.any(Boolean),
    });
  });
});

describe('dismissUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a function', () => {
    expect(typeof dismissUpdate).toBe('function');
  });

  it('resets status to idle after dismiss', async () => {
    // dismissUpdate resets state to idle regardless
    await dismissUpdate();
    const s = getStatus();
    expect(s.state).toBe('idle');
    expect(s.availableVersion).toBeNull();
    expect(s.releaseNotes).toBeNull();
    expect(s.downloadProgress).toBe(0);
  });
});
