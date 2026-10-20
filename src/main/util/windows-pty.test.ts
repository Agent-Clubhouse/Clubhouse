import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  release: vi.fn(() => '10.0.22631'),
}));

import { detectWindowsPty, windowsPtyLaunchArgs } from './windows-pty';
import { parseWindowsPtyArg } from '../../shared/windows-pty';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('detectWindowsPty', () => {
  afterEach(() => setPlatform(originalPlatform));

  it('is undefined off Windows', () => {
    expect(detectWindowsPty('linux', '6.8.0-45-generic')).toBeUndefined();
    expect(detectWindowsPty('darwin', '25.5.0')).toBeUndefined();
  });

  it('reports ConPTY from build 18309 on, as node-pty picks it', () => {
    expect(detectWindowsPty('win32', '10.0.22631')).toEqual({ backend: 'conpty', buildNumber: 22631 });
    expect(detectWindowsPty('win32', '10.0.18309')).toEqual({ backend: 'conpty', buildNumber: 18309 });
  });

  it('reports winpty on older builds', () => {
    expect(detectWindowsPty('win32', '10.0.17763')).toEqual({ backend: 'winpty', buildNumber: 17763 });
  });

  it('falls back to winpty without a build number when the release is unreadable', () => {
    expect(detectWindowsPty('win32', 'garbage')).toEqual({ backend: 'winpty' });
  });

  it('reads the live platform and os.release() by default', () => {
    setPlatform('win32');
    expect(detectWindowsPty()).toEqual({ backend: 'conpty', buildNumber: 22631 });
  });
});

describe('windowsPtyLaunchArgs', () => {
  afterEach(() => setPlatform(originalPlatform));

  it('passes the backend to preload on Windows', () => {
    setPlatform('win32');
    expect(parseWindowsPtyArg(windowsPtyLaunchArgs())).toEqual({ backend: 'conpty', buildNumber: 22631 });
  });

  it('adds nothing off Windows', () => {
    setPlatform('linux');
    expect(windowsPtyLaunchArgs()).toEqual([]);
  });
});
