/**
 * appLog writes through the diag tier (#2301): startup lines are held until
 * the recorder starts, the logging settings gate them and diag redacts them.
 * Nothing else is written (#2313).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSettings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({}) as Record<string, unknown>),
}));
vi.mock('./log-settings', () => logSettings);

import { _resetDiagForTests, setDiagSink, type DiagRecord } from '../telemetry/diag';
import { _resetEarlyLogForTests, appLog, flush, flushSync, init } from './log-service';

const HOME = '/Users/sam-tester';
const settings = (over: Record<string, unknown> = {}) => ({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info', ...over });

function memorySink() {
  const lines: DiagRecord[] = [];
  return {
    lines,
    writeDiag: (r: DiagRecord) => lines.push(r),
    noteDiagDropped: vi.fn(),
    flush: vi.fn(async () => {}),
    flushSync: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetDiagForTests(HOME);
  _resetEarlyLogForTests();
  logSettings.getSettings.mockReturnValue(settings());
});

afterEach(() => {
  _resetDiagForTests();
});

describe('appLog → diag', () => {
  it('holds lines from before the recorder starts and writes them, in order, once it has', () => {
    appLog('core:startup', 'info', 'first');
    appLog('core:orchestrator', 'warn', 'second', { meta: { error: 'boom' } });
    const sink = memorySink();
    setDiagSink(sink);
    expect(sink.lines).toEqual([]);
    appLog('core:startup', 'info', 'third');
    expect(sink.lines.map((l) => [l.ns, l.level, l.msg])).toEqual([
      ['core:startup', 'info', 'first'],
      ['core:orchestrator', 'warn', 'second'],
      ['core:startup', 'info', 'third'],
    ]);
    expect(sink.lines[1].meta).toEqual({ error: 'boom' });
  });

  it('writes held lines at init() even when nothing is logged after the recorder starts', () => {
    appLog('core:startup', 'info', 'early');
    const sink = memorySink();
    setDiagSink(sink);
    init();
    expect(sink.lines.map((l) => l.msg)).toEqual(['early']);
  });

  it('drops held lines at init() when the recorder never started (logging off), and holds no more', () => {
    appLog('core:startup', 'info', 'early');
    init();
    const sink = memorySink();
    setDiagSink(sink);
    appLog('core:startup', 'info', 'later');
    expect(sink.lines.map((l) => l.msg)).toEqual(['later']);
  });

  it('keeps only the newest held lines and notes how many were dropped', () => {
    for (let i = 0; i < 210; i++) appLog('core:startup', 'info', `line ${i}`);
    const sink = memorySink();
    setDiagSink(sink);
    appLog('core:startup', 'info', 'after');
    expect(sink.lines).toHaveLength(202);
    expect(sink.lines[0]).toMatchObject({ ns: 'core:startup', level: 'warn', meta: { dropped: 10 } });
    expect(sink.lines[1].msg).toBe('line 10');
    expect(sink.lines[201].msg).toBe('after');
  });

  it('holds a copy of meta, not the caller\'s object', () => {
    const meta: Record<string, unknown> = { step: 'before' };
    appLog('core:startup', 'info', 'early', { meta });
    meta.step = 'after';
    const sink = memorySink();
    setDiagSink(sink);
    appLog('core:startup', 'info', 'now');
    expect(sink.lines[0].meta).toEqual({ step: 'before' });
  });

  it('follows the logging settings: enabled, namespaces, minLogLevel', () => {
    const sink = memorySink();
    setDiagSink(sink);
    appLog('core:pty', 'info', 'kept');
    appLog('core:pty', 'debug', 'below min level');
    logSettings.getSettings.mockReturnValue(settings({ namespaces: { 'core:pty': false } }));
    appLog('core:pty', 'error', 'namespace off');
    appLog('core:git', 'warn', 'other namespace');
    logSettings.getSettings.mockReturnValue(settings({ enabled: false }));
    appLog('core:git', 'fatal', 'logging off');
    expect(sink.lines.map((l) => [l.ns, l.level, l.msg])).toEqual([
      ['core:pty', 'info', 'kept'],
      ['core:git', 'warn', 'other namespace'],
    ]);
  });

  it('gates held lines by the settings when they are written', () => {
    appLog('core:pty', 'debug', 'held debug');
    appLog('core:pty', 'info', 'held info');
    const sink = memorySink();
    setDiagSink(sink);
    appLog('core:pty', 'info', 'now');
    expect(sink.lines.map((l) => l.msg)).toEqual(['held info', 'now']);
  });

  it('redacts msg and meta, held lines included', () => {
    appLog('core:agent', 'info', `Spawning in ${HOME}/repo`, { meta: { prompt: 'secret mission', token: 'abc' } });
    const sink = memorySink();
    setDiagSink(sink);
    appLog('core:agent', 'error', `Failed in ${HOME}/repo`, { meta: { args: ['-p', 'secret mission'], exitCode: 1 } });
    const all = JSON.stringify(sink.lines);
    expect(all).not.toContain(HOME);
    expect(all).not.toContain('secret mission');
    expect(all).not.toContain('abc');
    expect(sink.lines[0].msg).toBe('Spawning in <home>/repo');
    expect(sink.lines[1].meta).toMatchObject({ exitCode: 1 });
  });

  it('puts projectId in meta', () => {
    const sink = memorySink();
    setDiagSink(sink);
    appLog('core:git', 'info', 'pulled', { projectId: 'p1', meta: { branch: 'main' } });
    appLog('core:git', 'info', 'no meta', { projectId: 'p2' });
    expect(sink.lines.map((l) => l.meta)).toEqual([{ projectId: 'p1', branch: 'main' }, { projectId: 'p2' }]);
  });

  it('keeps the feedback report id, so a report still matches the local record (#2309, #2313)', () => {
    const sink = memorySink();
    setDiagSink(sink);
    const id = '3f2b8c1e-7d4a-4e9b-a1c2-5d6e7f8a9b0c';
    appLog('core:feedback', 'info', 'Feedback saved for delivery', { meta: { id, status: 'queued', state: 'connected' } });
    appLog('core:feedback', 'info', 'Feedback delivered', { meta: { id, status: 'accepted' } });
    expect(sink.lines.map((l) => [l.ns, l.msg, l.meta?.id])).toEqual([
      ['core:feedback', 'Feedback saved for delivery', id],
      ['core:feedback', 'Feedback delivered', id],
    ]);
  });

  it('flushes the recorder', async () => {
    const sink = memorySink();
    setDiagSink(sink);
    await flush();
    expect(sink.flush).toHaveBeenCalled();
    flushSync();
    expect(sink.flushSync).toHaveBeenCalled();
  });

  it('never throws when the recorder does', () => {
    setDiagSink({ ...memorySink(), writeDiag: () => { throw new Error('disk full'); } });
    expect(() => appLog('core:x', 'error', 'm')).not.toThrow();
  });
});
