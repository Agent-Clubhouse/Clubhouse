import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'stream';
import type { UpdateManifest } from '../../shared/types';

// ---------------------------------------------------------------------------
// Hoisted variables for use in vi.mock factories
// ---------------------------------------------------------------------------

const { httpsGetSpy, mockSettings } = vi.hoisted(() => ({
  httpsGetSpy: vi.fn(),
  mockSettings: {
    autoUpdate: true,
    previewChannel: false,
    lastCheck: null as string | null,
    dismissedVersion: null as string | null,
    lastSeenVersion: '0.25.0' as string | null,
  },
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
    save: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock('https', () => ({ get: httpsGetSpy }));
vi.mock('http', () => ({ get: vi.fn() }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    unlink: vi.fn((_p: string, cb: () => void) => cb()),
    createWriteStream: actual.createWriteStream,
    createReadStream: actual.createReadStream,
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

import { checkForUpdates } from './auto-update-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(version: string, overrides?: Partial<UpdateManifest>): UpdateManifest {
  const key = `${process.platform}-${process.arch}`;
  return {
    version,
    releaseDate: '2026-01-01',
    releaseNotes: 'Test notes',
    releaseMessage: 'Test Message',
    artifacts: {
      [key]: {
        url: 'https://example.com/Clubhouse-1.0.0.zip',
        sha256: 'abc123',
        size: 1000,
      },
    },
    ...overrides,
  };
}

/**
 * Mock https.get to call the callback synchronously (so data/end listeners
 * get attached) then emit data + end on the next tick.
 */
function mockHttpsGet(statusCode: number, body: string) {
  httpsGetSpy.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
      resume: () => void;
      pipe: (dest: unknown) => unknown;
    };
    res.statusCode = statusCode;
    res.headers = {};
    res.resume = vi.fn();
    res.pipe = vi.fn((dest) => dest);

    // Call callback synchronously so fetchJSON attaches data/end listeners
    cb(res);

    // Emit data + end on next tick (listeners are already attached)
    process.nextTick(() => {
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });

    const req = new EventEmitter();
    return req;
  });
}

function mockHttpsGetError(errorMessage: string) {
  httpsGetSpy.mockImplementation((_url: string, _opts: unknown, _cb: unknown) => {
    const req = new EventEmitter();
    process.nextTick(() => req.emit('error', new Error(errorMessage)));
    return req;
  });
}

// ---------------------------------------------------------------------------
// Tests — paths that DON'T involve downloading (resolve before download)
// ---------------------------------------------------------------------------

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.autoUpdate = true;
    mockSettings.previewChannel = false;
    mockSettings.lastCheck = null;
    mockSettings.dismissedVersion = null;
    mockSettings.lastSeenVersion = '0.25.0';
  });

  it('skips check when autoUpdate is false and not manual', async () => {
    mockSettings.autoUpdate = false;
    const result = await checkForUpdates(false);
    expect(httpsGetSpy).not.toHaveBeenCalled();
    expect(result.state).toBe('idle');
  });

  it('proceeds with fetch when autoUpdate is false but check is manual', async () => {
    mockSettings.autoUpdate = false;
    // Use a version that's NOT newer so we don't enter download flow
    const manifest = makeManifest('0.0.0');
    mockHttpsGet(200, JSON.stringify(manifest));

    const result = await checkForUpdates(true);
    expect(httpsGetSpy).toHaveBeenCalled();
    expect(result.state).toBe('idle');
  });

  it('returns idle when current version is up to date', async () => {
    const manifest = makeManifest('0.0.0');
    mockHttpsGet(200, JSON.stringify(manifest));

    const result = await checkForUpdates(true);
    expect(result.state).toBe('idle');
  });

  it('skips dismissed version on non-manual check', async () => {
    const manifest = makeManifest('1.0.0');
    mockSettings.dismissedVersion = '1.0.0';
    mockHttpsGet(200, JSON.stringify(manifest));

    const result = await checkForUpdates(false);
    expect(result.state).toBe('idle');
  });

  it('returns idle when no artifact for current platform', async () => {
    const manifest = makeManifest('1.0.0', {
      artifacts: { 'fake-platform-fake-arch': { url: 'x', sha256: 'y' } },
    });
    mockHttpsGet(200, JSON.stringify(manifest));

    const result = await checkForUpdates(true);
    expect(result.state).toBe('idle');
  });

  it('sets error state on non-retryable HTTP error', async () => {
    mockHttpsGet(500, 'Internal Server Error');
    const result = await checkForUpdates(true);
    expect(result.state).toBe('error');
    expect(result.error).toContain('HTTP 500');
  });

  it('sets error state on invalid JSON response', async () => {
    mockHttpsGet(200, 'not valid json');
    const result = await checkForUpdates(true);
    expect(result.state).toBe('error');
  });

  it('fetches both manifests when preview channel is enabled', async () => {
    mockSettings.previewChannel = true;
    // Both manifests report an old version → idle, no download
    const manifest = makeManifest('0.0.0');
    mockHttpsGet(200, JSON.stringify(manifest));

    const result = await checkForUpdates(true);
    // At least 2 calls: stable + preview
    expect(httpsGetSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.state).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Tests with fake timers for retry delays
// ---------------------------------------------------------------------------

describe('checkForUpdates (retry paths)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSettings.autoUpdate = true;
    mockSettings.previewChannel = false;
    mockSettings.lastCheck = null;
    mockSettings.dismissedVersion = null;
    mockSettings.lastSeenVersion = '0.25.0';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets error state on transient network failure after retries', async () => {
    mockHttpsGetError('connect ECONNREFUSED 127.0.0.1:443');

    const promise = checkForUpdates(true);
    // 3 retries: 5s, 10s, 20s
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);

    const result = await promise;
    expect(result.state).toBe('error');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('handles request timeout with retries', async () => {
    httpsGetSpy.mockImplementation((_url: string, _opts: unknown, _cb: unknown) => {
      const req = new EventEmitter();
      process.nextTick(() => req.emit('timeout'));
      req.destroy = vi.fn(() => {
        process.nextTick(() => req.emit('error', new Error('Request timed out')));
        return req as ReturnType<typeof req.destroy>;
      });
      return req;
    });

    const promise = checkForUpdates(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);

    const result = await promise;
    expect(result.state).toBe('error');
    expect(result.error).toContain('timed out');
  });
});
