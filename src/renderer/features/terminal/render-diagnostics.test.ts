import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';

vi.mock('../../plugins/renderer-logger', () => ({ rendererLog: vi.fn() }));

import { rendererLog } from '../../plugins/renderer-logger';
import {
  POST_RESIZE_WINDOW_MS,
  RENDER_LOG_NS,
  _resetRenderDiagnosticsForTests,
  classifyChunk,
  createTerminalRenderDiagnostics,
  mountedTerminalCount,
} from './render-diagnostics';

const log = vi.mocked(rendererLog);

function lines(msg: string) {
  return log.mock.calls.filter((c) => c[0] === RENDER_LOG_NS && c[2] === msg);
}

function meta(msg: string, i = 0) {
  return lines(msg)[i]?.[3]?.meta as Record<string, unknown>;
}

/** A real xterm parser and buffer, without a DOM renderer. Writes run on (fake) timers. */
function headless(): { term: Terminal; write: (d: string) => Promise<void> } {
  const h = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
  return {
    term: h as unknown as Terminal,
    write: async (d) => {
      const parsed = new Promise<void>((resolve) => h.write(d, resolve));
      await vi.advanceTimersByTimeAsync(1);
      await parsed;
    },
  };
}

describe('classifyChunk', () => {
  it('classifies a chunk by where it starts and ends against appliedSeq', () => {
    expect(classifyChunk(10, 110, 100)).toEqual({ kind: 'fresh', chars: 0 });
    expect(classifyChunk(10, 105, 100)).toEqual({ kind: 'overlap', chars: 5 });
    expect(classifyChunk(10, 100, 100)).toEqual({ kind: 'covered', chars: 10 });
    expect(classifyChunk(10, 90, 100)).toEqual({ kind: 'covered', chars: 10 });
    expect(classifyChunk(10, 120, 100)).toEqual({ kind: 'gap', chars: 10 });
    expect(classifyChunk(10, undefined, 100)).toEqual({ kind: 'unsequenced', chars: 0 });
    expect(classifyChunk(10, 5, -1)).toEqual({ kind: 'fresh', chars: 0 });
  });

  it('calls a chunk a duplicate only when its seq was already delivered as a chunk', () => {
    expect(classifyChunk(10, 100, 100, 100)).toEqual({ kind: 'duplicate', chars: 10 });
    expect(classifyChunk(10, 100, 100, 90)).toEqual({ kind: 'covered', chars: 10 });
    // Detected even without a snapshot (failed fetch).
    expect(classifyChunk(10, 50, -1, 60)).toEqual({ kind: 'duplicate', chars: 10 });
  });
});

describe('createTerminalRenderDiagnostics', () => {
  beforeEach(() => {
    log.mockClear();
    vi.useFakeTimers();
    _resetRenderDiagnosticsForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (sessionId = 's1', remote = false) =>
    createTerminalRenderDiagnostics({ sessionId, surface: 'agent', remote });

  it('summarizes a local replay: trimmed overlap at info, nothing duplicated', () => {
    const diag = make();
    diag.beginReplay('local', 500, 500);
    diag.replayChunk(20, 510, 500); // straddles the snapshot: 10 trimmed
    diag.endReplay();
    const m = meta('Terminal buffer replay');
    expect(lines('Terminal buffer replay')[0][1]).toBe('info');
    expect(m).toMatchObject({ source: 'local', snapshotLength: 500, snapshotSeq: 500, pendingChunks: 1, overlaps: 1, overlapChars: 10, duplicates: 0, gaps: 0 });
    diag.dispose();
  });

  it('counts queued chunks wholly inside the snapshot as covered, not as an anomaly', () => {
    const diag = make();
    diag.beginReplay('local', 500, 500);
    diag.replayChunk(20, 480, 500);
    diag.replayChunk(20, 500, 500);
    diag.endReplay();
    expect(lines('Terminal buffer replay')[0][1]).toBe('info');
    expect(meta('Terminal buffer replay')).toMatchObject({ covered: 2, coveredChars: 40, duplicates: 0 });
    diag.dispose();
  });

  it('warns when a queued chunk repeats a delivered seq or leaves a gap', () => {
    const diag = make();
    diag.beginReplay('local', 500, 500);
    diag.replayChunk(20, 480, 500);
    diag.replayChunk(20, 480, 500);
    diag.replayChunk(5, 520, 500);
    diag.endReplay();
    expect(lines('Terminal buffer replay')[0][1]).toBe('warn');
    expect(meta('Terminal buffer replay')).toMatchObject({ covered: 1, duplicates: 1, duplicateChars: 20, gaps: 1, gapChars: 15 });
    diag.dispose();
  });

  it('flags remote replays that queued chunks (no seq to trim them)', () => {
    const diag = make('r1', true);
    diag.beginReplay('remote', 300);
    diag.replayChunk(12, undefined, -1);
    diag.endReplay();
    expect(lines('Terminal buffer replay')[0][1]).toBe('warn');
    expect(meta('Terminal buffer replay')).toMatchObject({ source: 'remote', pendingChunks: 1, unsequenced: 1, remote: true });
    diag.dispose();
  });

  it('warns on a live chunk delivered twice (same seq) and on a gap', () => {
    const diag = make();
    diag.liveChunk(10, 100, 90);
    diag.liveChunk(10, 100, 100);
    diag.liveChunk(10, 130, 100);
    expect(meta('PTY chunk delivered twice')).toMatchObject({ length: 10, seq: 100, appliedSeq: 100 });
    expect(meta('PTY output gap')).toMatchObject({ chars: 20 });
    diag.dispose();
    expect(lines('Terminal render summary')[0][1]).toBe('warn');
    expect(meta('Terminal render summary')).toMatchObject({ liveChunks: 3, duplicates: 1, gaps: 1 });
  });

  it('does not warn about a live chunk the snapshot already covered (merged broadcast)', () => {
    const diag = make();
    diag.beginReplay('local', 100, 100);
    diag.endReplay();
    diag.liveChunk(10, 95, 100);
    expect(lines('PTY chunk delivered twice')).toHaveLength(0);
    diag.dispose();
    expect(meta('Terminal render summary')).toMatchObject({ covered: 1, duplicates: 0 });
  });

  it('treats the seq jump after a PTY exit as a respawn, not a gap', () => {
    const diag = make();
    diag.liveChunk(10, 100, 90);
    diag.ptyExited();
    diag.liveChunk(10, 5000, 100);
    diag.liveChunk(10, 6000, 5000);
    expect(lines('PTY output gap')).toHaveLength(1);
    diag.dispose();
    expect(meta('Terminal render summary')).toMatchObject({ respawnJumps: 1, gaps: 1 });
  });

  it('keeps the line budget across remounts of the same session', () => {
    for (let i = 0; i < 10; i++) make('remounted').dispose();
    expect(lines('Terminal render summary')).toHaveLength(6);
  });

  it('logs nothing once disposed', () => {
    const diag = make();
    diag.dispose();
    log.mockClear();
    diag.beginReplay('local', 10, 10);
    diag.endReplay(true);
    diag.liveChunk(10, 100, 0);
    diag.resize('mount', 10, 10, true);
    vi.advanceTimersByTime(POST_RESIZE_WINDOW_MS);
    expect(log).not.toHaveBeenCalled();
  });

  it('opens a post-resize window on every send, even of an unchanged size', () => {
    const diag = make();
    diag.resize('mount', 80, 24, true);
    vi.advanceTimersByTime(POST_RESIZE_WINDOW_MS);
    diag.resize('window-focus', 80, 24, true);
    diag.liveChunk(50, undefined, -1);
    vi.advanceTimersByTime(POST_RESIZE_WINDOW_MS);
    expect(meta('Post-resize repaint')).toMatchObject({ cols: 80, rows: 24, chars: 50 });
    diag.dispose();
  });

  it('logs a device pixel ratio change with the size fit would pick', () => {
    const listeners: Array<() => void> = [];
    const matchMedia = vi.fn(() => ({
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    const { term } = headless();
    const diag = make();
    diag.attach(term, { proposeDimensions: () => ({ cols: 91, rows: 24 }) } as never);
    listeners[0]();
    expect(meta('Device pixel ratio changed')).toMatchObject({ cols: 80, rows: 24, proposedCols: 91, proposedRows: 24 });
    // Re-armed for the new ratio.
    expect(matchMedia).toHaveBeenCalledTimes(2);
    diag.dispose();
    vi.unstubAllGlobals();
  });

  it('logs size changes only, with the trigger, mounted instances and DPR', () => {
    const a = make('shared');
    const b = make('shared');
    expect(mountedTerminalCount('shared')).toBe(2);
    a.resize('mount', 80, 24, true);
    a.resize('window-focus', 80, 24, true);
    a.resize('resize-observer', 100, 30, false);
    expect(lines('Terminal resize')).toHaveLength(2);
    expect(meta('Terminal resize', 1)).toMatchObject({
      trigger: 'resize-observer', cols: 100, rows: 30, prevCols: 80, prevRows: 24,
      sent: false, unchangedFits: 1, instances: 2, dpr: window.devicePixelRatio,
    });
    a.dispose();
    b.dispose();
    expect(mountedTerminalCount('shared')).toBe(0);
  });

  it('records the repaint the child sends after a resize: chars, clears and sync frames', async () => {
    const { term, write } = headless();
    const diag = make();
    diag.attach(term);
    diag.resize('pane-focus', 100, 30, true);
    const repaint = '\x1b[?2026h\x1b[2J\x1b[3J\x1b[Hredrawn\x1b[?2026l';
    diag.liveChunk(repaint.length, undefined, -1);
    await write(repaint);
    vi.advanceTimersByTime(POST_RESIZE_WINDOW_MS);
    expect(meta('Post-resize repaint')).toMatchObject({
      cols: 100, rows: 30, chunks: 1, chars: repaint.length, clearScreens: 1, clearScrollbacks: 1, syncFrames: 1,
    });
    expect(JSON.stringify(lines('Post-resize repaint'))).not.toContain('redrawn');
    diag.dispose();
  });

  it('logs alternate-screen enter and exit, but counts history toggles during replay', async () => {
    const { term, write } = headless();
    const diag = make();
    diag.attach(term);
    diag.beginReplay('local', 16, 16);
    await write('\x1b[?1049hx\x1b[?1049l');
    diag.endReplay();
    expect(lines('Alternate screen entered')).toHaveLength(0);
    expect(meta('Terminal buffer replay')).toMatchObject({ historyAltScreenToggles: 2, altScreen: false });

    await write('\x1b[?1049h');
    await write('\x1b[?1049l');
    expect(lines('Alternate screen entered')).toHaveLength(1);
    expect(lines('Alternate screen exited')).toHaveLength(1);
    diag.dispose();
    expect(meta('Terminal render summary')).toMatchObject({ altScreenToggles: 2 });
  });

  it('counts parser events after snapshotParsed as live, before the summary is logged', async () => {
    const { term, write } = headless();
    const diag = make();
    diag.attach(term);
    diag.beginReplay('local', 8, 8);
    await write('\x1b[?1049h');
    diag.snapshotParsed();
    await write('\x1b[?1049l');
    diag.endReplay();
    expect(meta('Terminal buffer replay')).toMatchObject({ historyAltScreenToggles: 1, altScreen: false });
    expect(lines('Alternate screen exited')).toHaveLength(1);
    diag.dispose();
  });

  it('stops observing the parser after dispose', async () => {
    const { term, write } = headless();
    const diag = make();
    diag.attach(term);
    diag.dispose();
    log.mockClear();
    await write('\x1b[?1049h');
    expect(lines('Alternate screen entered')).toHaveLength(0);
  });
});
