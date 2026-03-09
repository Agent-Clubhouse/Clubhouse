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

import * as fs from 'fs';
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
    it('writes attempt as JSON to the correct path', () => {
      const attempt = { version: '0.30.0', artifactUrl: 'https://example.com/a.zip', attemptedAt: '2026-01-01T00:00:00Z' };
      writeApplyAttempt(attempt);
      // Find the call that wrote to the apply-attempt file
      const calls = vi.mocked(fs.writeFileSync).mock.calls;
      const call = calls.find((c) => String(c[0]).includes('update-apply-attempt.json'));
      expect(call).toBeDefined();
      expect(call![1]).toBe(JSON.stringify(attempt));
    });

    it('does not throw on write failure', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => { throw new Error('EPERM'); });
      expect(() => writeApplyAttempt({
        version: '0.30.0', artifactUrl: null, attemptedAt: '2026-01-01T00:00:00Z',
      })).not.toThrow();
    });
  });

  describe('readApplyAttempt', () => {
    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readApplyAttempt()).toBeNull();
    });

    it('returns parsed attempt when file exists', () => {
      const attempt = { version: '0.30.0', artifactUrl: 'https://example.com/a.zip', attemptedAt: '2026-01-01T00:00:00Z' };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(attempt));
      expect(readApplyAttempt()).toEqual(attempt);
    });

    it('returns null on invalid JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json');
      expect(readApplyAttempt()).toBeNull();
    });
  });

  describe('clearApplyAttempt', () => {
    it('unlinks the attempt file', () => {
      clearApplyAttempt();
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('update-apply-attempt.json'),
      );
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => clearApplyAttempt()).not.toThrow();
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
    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(getPendingReleaseNotes()).toBeNull();
    });

    it('returns parsed notes when file exists', () => {
      const notes = { version: '0.30.0', releaseNotes: '## Bug fixes\n- Fixed a bug' };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(notes));
      expect(getPendingReleaseNotes()).toEqual(notes);
    });

    it('returns null on invalid JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{bad');
      expect(getPendingReleaseNotes()).toBeNull();
    });
  });

  describe('clearPendingReleaseNotes', () => {
    it('unlinks the notes file', () => {
      clearPendingReleaseNotes();
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('pending-release-notes.json'),
      );
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => clearPendingReleaseNotes()).not.toThrow();
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

  it('resets status to idle after dismiss', () => {
    // dismissUpdate resets state to idle regardless
    dismissUpdate();
    const s = getStatus();
    expect(s.state).toBe('idle');
    expect(s.availableVersion).toBeNull();
    expect(s.releaseNotes).toBeNull();
    expect(s.downloadProgress).toBe(0);
  });
});
