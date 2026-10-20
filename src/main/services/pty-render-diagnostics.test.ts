import { beforeEach, describe, expect, it, vi } from 'vitest';

const appLog = vi.hoisted(() => vi.fn());
vi.mock('./log-service', () => ({ appLog }));

import {
  PTY_RENDER_LOG_NS,
  _resetForTests,
  forget,
  ptyBackend,
  recordOutput,
  recordResize,
  recordSnapshot,
  recordSpawn,
  windowsBuildNumber,
} from './pty-render-diagnostics';

function lines(msg: string) {
  return appLog.mock.calls.filter((c) => c[0] === PTY_RENDER_LOG_NS && c[2] === msg);
}

describe('pty-render-diagnostics', () => {
  let t = 0;
  beforeEach(() => {
    appLog.mockClear();
    t = 0;
    _resetForTests(() => t);
  });

  describe('ptyBackend', () => {
    it('is unix off Windows', () => {
      expect(ptyBackend('linux', '6.8.0-45-generic')).toBe('unix');
      expect(ptyBackend('darwin', '25.5.0')).toBe('unix');
    });

    it('follows node-pty: ConPTY from build 18309, winpty before', () => {
      expect(ptyBackend('win32', '10.0.19045')).toBe('conpty');
      expect(ptyBackend('win32', '10.0.18309')).toBe('conpty');
      expect(ptyBackend('win32', '10.0.17763')).toBe('winpty');
      expect(ptyBackend('win32', 'garbage')).toBe('winpty');
    });

    it('parses the Windows build number', () => {
      expect(windowsBuildNumber('10.0.22631')).toBe(22631);
      expect(windowsBuildNumber('6.8.0')).toBeUndefined();
    });
  });

  it('logs spawn with size, platform and backend, at info', () => {
    recordSpawn('a1', 'agent', 120, 30);
    const [line] = lines('PTY session started');
    expect(line[1]).toBe('info');
    expect(line[3].meta).toMatchObject({
      sessionId: 'a1', kind: 'agent', cols: 120, rows: 30,
      platform: process.platform, backend: ptyBackend(),
    });
  });

  it('logs size changes with the previous size, and counts repeats of the same size', () => {
    recordSpawn('a1', 'agent', 120, 30);
    recordResize('a1', 120, 30);
    recordResize('a1', 120, 30);
    expect(lines('PTY resize')).toHaveLength(0);
    recordResize('a1', 100, 40);
    const [line] = lines('PTY resize');
    expect(line[3].meta).toMatchObject({ cols: 100, rows: 40, prevCols: 120, prevRows: 30, unchangedResizes: 2 });
  });

  it('rate-limits resize lines per session and reports the suppressed count', () => {
    recordSpawn('a1', 'agent', 120, 30);
    for (let i = 0; i < 10; i++) recordResize('a1', 50 + i, 20);
    expect(lines('PTY resize')).toHaveLength(6);
    t = 60_000;
    recordResize('a1', 200, 50);
    const last = lines('PTY resize').at(-1)!;
    expect(last[3].meta).toMatchObject({ cols: 200, suppressed: 4 });
  });

  it('logs one burst line per one-second window over the threshold', () => {
    recordSpawn('a1', 'agent', 120, 30);
    for (let i = 0; i < 3; i++) recordOutput('a1', 128 * 1024);
    expect(lines('PTY output burst')).toHaveLength(1);
    expect(lines('PTY output burst')[0][3].meta).toMatchObject({ chars: 256 * 1024, chunks: 2 });
    t = 1000;
    recordOutput('a1', 10);
    expect(lines('PTY output burst')).toHaveLength(1);
  });

  it('logs snapshots with eviction, never content', () => {
    recordSpawn('a1', 'shell', 120, 30);
    recordSnapshot('a1', 2048, 9000, 512, 3);
    const [line] = lines('PTY buffer snapshot served');
    expect(line[3].meta).toEqual(expect.objectContaining({ length: 2048, seq: 9000, evictedChars: 512, sizeSegments: 3 }));
    expect(JSON.stringify(line)).not.toMatch(/data/);
  });

  it('ignores unknown and forgotten sessions', () => {
    recordResize('nope', 1, 1);
    recordSpawn('a1', 'agent', 120, 30);
    forget('a1');
    recordResize('a1', 1, 1);
    recordSnapshot('a1', 1, 1, 0, 1);
    expect(lines('PTY resize')).toHaveLength(0);
    expect(lines('PTY buffer snapshot served')).toHaveLength(0);
  });
});
