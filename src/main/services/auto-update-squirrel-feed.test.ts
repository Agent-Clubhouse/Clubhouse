import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'stream';

const { httpsGetSpy, mockSpawn } = vi.hoisted(() => ({
  httpsGetSpy: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
  flush: vi.fn(),
  flushSync: vi.fn(),
}));

vi.mock('./settings-store', () => ({
  createSettingsStore: () => ({
    get: () => ({
      autoUpdate: true,
      previewChannel: true,
      lastCheck: null,
      dismissedVersion: null,
      lastSeenVersion: '0.25.0',
    }),
    save: vi.fn(),
  }),
}));

vi.mock('https', () => ({ get: httpsGetSpy }));
vi.mock('http', () => ({ get: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync: vi.fn(), spawn: mockSpawn }));
vi.mock('./fs-utils', () => ({ pathExists: async () => true }));
vi.mock('./chat-runtime-settings', () => ({ isChatEnabled: () => false }));

import { applyWindowsUpdate, checkForUpdates } from './auto-update-service';

/** Serves each manifest by URL, so the check can pick between them. */
function serveManifests(versions: { latest: string; preview: string }) {
  httpsGetSpy.mockImplementation((url: string, _opts: unknown, cb: (res: unknown) => void) => {
    const version = url.includes('/preview.json') ? versions.preview : versions.latest;
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, resume: vi.fn() });
    cb(res);
    process.nextTick(() => {
      res.emit('data', Buffer.from(JSON.stringify({
        version,
        releaseDate: '2026-01-01',
        artifacts: { [`win32-${process.arch}`]: { url: 'https://example.com/Setup.exe', sha256: 'abc', size: 1 } },
      })));
      res.emit('end');
    });
    return new EventEmitter();
  });
}

async function feedUsedForApply(): Promise<string> {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  mockSpawn.mockImplementation(() => {
    process.nextTick(() => child.emit('spawn'));
    return child;
  });
  await checkForUpdates(true);
  await applyWindowsUpdate({ downloadPath: '', version: '1.0.0', artifactUrl: null }, { relaunch: false });
  return mockSpawn.mock.calls[0][1][1];
}

describe('Windows Squirrel feed on the preview channel', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('applies from the stable feed when a stable build beats the preview one', async () => {
    serveManifests({ latest: '99.0.0', preview: '99.0.0-beta.13' });
    expect(await feedUsedForApply()).toContain(`/squirrel/stable/win32-${process.arch}`);
  });

  it('applies from the preview feed when a preview build is newest', async () => {
    serveManifests({ latest: '98.0.0', preview: '99.0.0-beta.1' });
    expect(await feedUsedForApply()).toContain(`/squirrel/preview/win32-${process.arch}`);
  });
});
