import { describe, it, expect, afterEach } from 'vitest';
import { localWindowsPtyOptions } from './windows-pty';

describe('localWindowsPtyOptions', () => {
  afterEach(() => { window.clubhouse.windowsPty = undefined; });

  it('passes the preload backend through as windowsPty', () => {
    window.clubhouse.windowsPty = { backend: 'conpty', buildNumber: 19045 };
    expect(localWindowsPtyOptions()).toEqual({ windowsPty: { backend: 'conpty', buildNumber: 19045 } });
  });

  it('is empty when preload reports no Windows pty', () => {
    window.clubhouse.windowsPty = undefined;
    expect(localWindowsPtyOptions()).toEqual({});
  });
});
