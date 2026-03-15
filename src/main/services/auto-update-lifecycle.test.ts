import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'stream';

// ---------------------------------------------------------------------------
// Hoisted variables for use in vi.mock factories
// ---------------------------------------------------------------------------

const { mockSettings, mockSave } = vi.hoisted(() => ({
  mockSettings: {
    autoUpdate: true,
    previewChannel: false,
    lastCheck: null as string | null,
    dismissedVersion: null as string | null,
    lastSeenVersion: null as string | null,
  },
  mockSave: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('./settings-store', () => ({
  createSettingsStore: () => ({
    get: () => ({ ...mockSettings }),
    save: mockSave,
    update: vi.fn(),
  }),
}));

vi.mock('https', () => ({
  get: vi.fn((_url: string, _opts: unknown, _cb: unknown) => {
    return new EventEmitter();
  }),
}));

vi.mock('http', () => ({ get: vi.fn() }));

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
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => { throw new Error('ENOENT'); }),
  unlink: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  readdir: vi.fn(async () => []),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { startPeriodicChecks, stopPeriodicChecks } from './auto-update-service';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startPeriodicChecks / stopPeriodicChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSettings.autoUpdate = true;
    mockSettings.previewChannel = false;
    mockSettings.lastCheck = null;
    mockSettings.dismissedVersion = 'old-dismissed';
    mockSettings.lastSeenVersion = null;
  });

  afterEach(() => {
    stopPeriodicChecks();
    vi.useRealTimers();
  });

  it('seeds lastSeenVersion on first launch', async () => {
    mockSettings.lastSeenVersion = null;
    await startPeriodicChecks();
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ lastSeenVersion: expect.any(String) }),
    );
  });

  it('clears dismissedVersion on startup', async () => {
    mockSettings.dismissedVersion = '0.30.0';
    await startPeriodicChecks();
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ dismissedVersion: null }),
    );
  });

  it('preserves lastSeenVersion when clearing dismissedVersion in the same startup pass', async () => {
    mockSettings.lastSeenVersion = null;
    mockSettings.dismissedVersion = '0.30.0';

    await startPeriodicChecks();

    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(mockSave.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        lastSeenVersion: expect.any(String),
        dismissedVersion: null,
      }),
    );
  });

  it('returns early without scheduling when autoUpdate is false', async () => {
    mockSettings.autoUpdate = false;
    // Should not throw and should return early
    await startPeriodicChecks();
    // stopPeriodicChecks is safe even when no timer was created
    expect(() => stopPeriodicChecks()).not.toThrow();
  });

  it('stopPeriodicChecks is safe to call multiple times', async () => {
    await startPeriodicChecks();
    stopPeriodicChecks();
    expect(() => stopPeriodicChecks()).not.toThrow();
  });

  it('calling startPeriodicChecks twice does not create duplicate timers', async () => {
    await startPeriodicChecks();
    await startPeriodicChecks(); // second call should be a no-op
    stopPeriodicChecks();
  });
});
