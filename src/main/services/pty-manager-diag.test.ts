/**
 * PTY diagnostics on the diag tier (#2306): exit and spawn-failure text,
 * stale sweeps and rejected writes reach local diag lines, redacted and
 * capped; telemetry gets only the counters and the spawn errno type, never
 * terminal text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockProcess = {
  pid: 4242,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};
vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockProcess) }));
vi.mock('../util/shell', async () => {
  const actual = await vi.importActual<typeof import('../util/shell')>('../util/shell');
  return { ...actual, getShellEnvironment: vi.fn(() => ({})), getDefaultShell: vi.fn(() => '/bin/zsh') };
});
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn(), flushPendingFor: vi.fn(), setChannelPolicy: vi.fn() }));
vi.mock('./annex-event-bus', () => ({ emitPtyExit: vi.fn(), emitPtyData: vi.fn(), isActive: vi.fn(() => false), onActiveChange: vi.fn(() => vi.fn()) }));
vi.mock('./pty-headless-terminal', () => ({ feedData: vi.fn(), resize: vi.fn(), serialize: vi.fn(() => ''), dispose: vi.fn(), disposeAll: vi.fn() }));
vi.mock('fs/promises', () => ({
  realpath: (p: string) => Promise.resolve(p),
  stat: () => Promise.resolve({ isDirectory: () => true }),
}));
const logSettings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' }) as Record<string, unknown>),
}));
vi.mock('./log-settings', () => logSettings);

import * as pty from 'node-pty';
import { _resetDiagForTests, setDiagSink, type DiagRecord } from '../telemetry/diag';
import { setProducingRuntime } from '../telemetry/__test-utils__/producing-runtime';
import { errorTypeOf, type TelemetryRuntime } from '../telemetry/types';
import { EXIT_TAIL_CHARS, gracefulKill, resize, spawn, spawnShell, startStaleSweep, stopStaleSweep, write, writeBinary } from './pty-manager';

const HOME = '/Users/sam-tester';

let lines: DiagRecord[];
let runtime: { level: string; count: ReturnType<typeof vi.fn>; event: ReturnType<typeof vi.fn>; exception: ReturnType<typeof vi.fn>; replaySpan: ReturnType<typeof vi.fn> };

function ptyLines(msg: string): DiagRecord[] {
  return lines.filter((l) => l.ns === 'core:pty' && l.msg === msg);
}

/** Everything the export runtime was given, as one string. */
function exported(): string {
  return JSON.stringify([runtime.count.mock.calls, runtime.event.mock.calls, runtime.exception.mock.calls, runtime.replaySpan.mock.calls]);
}

async function spawnWithOutput(agentId: string, output: string[]): Promise<(exitCode: number) => void> {
  await spawn(agentId, '/test', '/opt/tools/bin/claude', []);
  resize(agentId, 100, 40);
  const onData = mockProcess.onData.mock.calls.at(-1)![0] as (d: string) => void;
  for (const chunk of output) onData(chunk);
  const onExit = mockProcess.onExit.mock.calls.at(-1)![0] as (e: { exitCode: number }) => void;
  return (exitCode) => onExit({ exitCode });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetDiagForTests(HOME);
  lines = [];
  setDiagSink({ writeDiag: (r) => lines.push(r), noteDiagDropped: vi.fn(), flush: async () => {} });
  runtime = { level: 'detailed', count: vi.fn(), event: vi.fn(), exception: vi.fn(), replaySpan: vi.fn() };
  setProducingRuntime(runtime as unknown as TelemetryRuntime);
});

afterEach(() => {
  setProducingRuntime(null);
  _resetDiagForTests();
});

describe('PTY exit diag line', () => {
  it('keeps the exit code, the binary name and the redacted, capped, plain last output of a failed exit', async () => {
    const exit = await spawnWithOutput('agent_fail', [
      'x'.repeat(3000) + '\n',
      `\x1b[31mError:\x1b[0m config at ${HOME}/.claude.json\r\n`,
      'ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz\n',
      '\x1b]0;title\x07zsh: command not found: claude\n',
    ]);
    exit(127);

    const [line] = ptyLines('PTY exited');
    expect(line).toMatchObject({ level: 'error', meta: { agentId: 'agent_fail', exitCode: 127, binary: 'claude' } });
    const lastOutput = line!.meta!.lastOutput as string;
    expect(lastOutput.length).toBeLessThanOrEqual(EXIT_TAIL_CHARS);
    expect(lastOutput).toContain('zsh: command not found: claude');
    expect(lastOutput).toContain('Error: config at <home>/.claude.json');
    expect(lastOutput).not.toContain('sk-ant-');
    expect(lastOutput).not.toContain(HOME);
    expect(lastOutput).not.toContain('\x1b');
    expect(lastOutput).not.toContain('title');
    expect(lastOutput.endsWith('claude\n')).toBe(true);
  });

  it('redacts before cutting, so a secret straddling the cut leaves no fragment', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    // The secret ends inside the kept tail and starts before it.
    const exit = await spawnWithOutput('agent_cut', [`token ${secret}` + ' '.repeat(EXIT_TAIL_CHARS - 20)]);
    exit(1);
    const lastOutput = ptyLines('PTY exited')[0]!.meta!.lastOutput as string;
    expect(lastOutput).not.toContain('AAAA');
  });

  it('keeps no last output for a clean or a requested exit', async () => {
    const clean = await spawnWithOutput('agent_ok', ['all done\n']);
    clean(0);
    const killed = await spawnWithOutput('agent_killed', ['bye\n']);
    gracefulKill('agent_killed');
    killed(130);

    const [ok, kill] = ptyLines('PTY exited');
    expect(ok).toEqual({ ns: 'core:pty', level: 'info', msg: 'PTY exited', meta: { agentId: 'agent_ok', exitCode: 0, binary: 'claude' } });
    expect(kill).toEqual({ ns: 'core:pty', level: 'info', msg: 'PTY exited', meta: { agentId: 'agent_killed', exitCode: 130, binary: 'claude' } });
  });

  it('sends no terminal text to export', async () => {
    const exit = await spawnWithOutput('agent_priv', ['very-private-output-canary\n']);
    exit(2);
    expect(ptyLines('PTY exited')).toHaveLength(1);
    expect(exported()).not.toContain('very-private-output-canary');
    expect(exported()).not.toContain('/opt/tools');
  });
});

describe('PTY spawn failure', () => {
  it('writes the full message to diag and tags the step with the errno', async () => {
    const err = Object.assign(new Error(`spawn ${HOME}/bin/zsh EACCES`), { code: 'EACCES' });
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw err; });
    await expect(spawn('agent_x', `${HOME}/repo`, '/opt/tools/bin/claude', [])).rejects.toBe(err);
    expect(errorTypeOf(err)).toBe('EACCES');
    expect(ptyLines('Failed to spawn PTY process')).toEqual([{
      ns: 'core:pty', level: 'error', msg: 'Failed to spawn PTY process',
      meta: { agentId: 'agent_x', binary: 'claude', cwd: '<home>/repo', code: 'EACCES', error: 'spawn <home>/bin/zsh EACCES' },
    }]);
  });

  it('finds the errno in the message, and leaves unnamed codes to the caller', async () => {
    const enoent = new Error('ENOENT: shell not found');
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw enoent; });
    await expect(spawnShell('shell_x', '/test')).rejects.toBe(enoent);
    expect(errorTypeOf(enoent)).toBe('ENOENT');
    expect(ptyLines('Failed to spawn shell PTY')[0]!.meta).toMatchObject({ sessionId: 'shell_x', code: 'ENOENT' });

    const posix = new Error('posix_spawnp failed.');
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw posix; });
    await expect(spawn('agent_y', '/test', 'claude', [])).rejects.toBe(posix);
    expect(errorTypeOf(posix)).toBe('unknown');
    expect(exported()).not.toContain('posix_spawnp');
  });
});

describe('PTY write rejections and stale sweeps', () => {
  it('records oversized writes in diag and counts them by kind', async () => {
    await spawn('agent_w', '/test', '/opt/tools/bin/claude', []);
    write('agent_w', 'p'.repeat(64 * 1024 + 1));
    writeBinary('agent_w', 'b'.repeat(64 * 1024 + 2));
    expect(mockProcess.write).not.toHaveBeenCalledWith(expect.stringContaining('ppp'));

    expect(ptyLines('Oversized PTY write rejected')[0]!.meta).toEqual({ agentId: 'agent_w', length: 65537, limit: 65536 });
    expect(ptyLines('Oversized PTY binary write rejected')[0]!.meta).toEqual({ agentId: 'agent_w', length: 65538, limit: 65536 });
    const rejected = runtime.count.mock.calls.filter(([name]) => name === 'clubhouse.pty.write_rejected');
    expect(rejected).toEqual([
      ['clubhouse.pty.write_rejected', 1, [{ key: 'clubhouse.pty.write.kind', kind: 'enum', value: 'text' }]],
      ['clubhouse.pty.write_rejected', 1, [{ key: 'clubhouse.pty.write.kind', kind: 'enum', value: 'binary' }]],
    ]);
    expect(exported()).not.toContain('ppp');
  });

  it('records a swept session in diag and counts it', async () => {
    vi.useFakeTimers();
    const originalKill = process.kill;
    process.kill = vi.fn(() => { throw new Error('ESRCH'); }) as never;
    try {
      await spawn('agent_stale', '/test', '/opt/tools/bin/claude', []);
      startStaleSweep();
      vi.advanceTimersByTime(30_000);
    } finally {
      stopStaleSweep();
      process.kill = originalKill;
      vi.useRealTimers();
    }
    expect(ptyLines('Stale PTY session detected, cleaning up').map((l) => l.meta)).toContainEqual({ agentId: 'agent_stale', pid: 4242 });
    expect(runtime.count).toHaveBeenCalledWith('clubhouse.pty.stale_swept', 1, undefined);
  });
});
