import { describe, it, expect } from 'vitest';
import { WINDOWS_PTY_ARG, parseWindowsPtyArg, windowsPtyArg } from './windows-pty';

describe('windows-pty launch argument', () => {
  it('round-trips the backend and build number', () => {
    const argv = ['--other', windowsPtyArg({ backend: 'conpty', buildNumber: 22631 })];
    expect(parseWindowsPtyArg(argv)).toEqual({ backend: 'conpty', buildNumber: 22631 });
  });

  it('omits an unknown build number', () => {
    expect(parseWindowsPtyArg([windowsPtyArg({ backend: 'winpty' })])).toEqual({ backend: 'winpty' });
  });

  it('is undefined when the argument is absent', () => {
    expect(parseWindowsPtyArg(['--clubhouse-new-chrome'])).toBeUndefined();
  });

  it('rejects an unknown backend', () => {
    expect(parseWindowsPtyArg([`${WINDOWS_PTY_ARG}unix:0`])).toBeUndefined();
  });

  it('drops a malformed build number', () => {
    expect(parseWindowsPtyArg([`${WINDOWS_PTY_ARG}conpty:abc`])).toEqual({ backend: 'conpty' });
  });
});
