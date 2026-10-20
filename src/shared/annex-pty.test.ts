import { describe, it, expect } from 'vitest';
import { annexPtyHost, windowsPtyForHost } from './annex-pty';

describe('annexPtyHost', () => {
  it('reports the backend and build on Windows', () => {
    expect(annexPtyHost('win32', { backend: 'conpty', buildNumber: 22631 }))
      .toEqual({ platform: 'win32', ptyBackend: 'conpty', windowsBuild: 22631 });
  });

  it('omits the build when it is unknown', () => {
    expect(annexPtyHost('win32', { backend: 'winpty' })).toEqual({ platform: 'win32', ptyBackend: 'winpty' });
  });

  it('reports a null backend off Windows', () => {
    expect(annexPtyHost('darwin', undefined)).toEqual({ platform: 'darwin', ptyBackend: null });
  });
});

describe('windowsPtyForHost', () => {
  it('maps a Windows satellite to the xterm hint', () => {
    expect(windowsPtyForHost({ platform: 'win32', ptyBackend: 'conpty', windowsBuild: 22631 }))
      .toEqual({ backend: 'conpty', buildNumber: 22631 });
    expect(windowsPtyForHost({ platform: 'win32', ptyBackend: 'winpty' })).toEqual({ backend: 'winpty' });
  });

  it('gives no hint for older satellites or other platforms', () => {
    expect(windowsPtyForHost(undefined)).toBeUndefined();
    expect(windowsPtyForHost({ platform: 'linux', ptyBackend: null })).toBeUndefined();
    expect(windowsPtyForHost({ platform: 'darwin', ptyBackend: 'conpty' })).toBeUndefined();
  });

  it('rejects malformed values from the network', () => {
    expect(windowsPtyForHost('win32')).toBeUndefined();
    expect(windowsPtyForHost({ platform: 'win32', ptyBackend: 'pty' })).toBeUndefined();
    expect(windowsPtyForHost({ platform: 'win32', ptyBackend: 'conpty', windowsBuild: 'x' })).toEqual({ backend: 'conpty' });
    expect(windowsPtyForHost({ platform: 'win32', ptyBackend: 'conpty', windowsBuild: -1 })).toEqual({ backend: 'conpty' });
  });
});
