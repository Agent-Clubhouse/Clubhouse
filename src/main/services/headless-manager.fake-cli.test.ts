import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real child processes, real files, real headless-manager (#2813). Only the
// sweep and kill timers are faked, so each case doesn't wait 30 seconds.
// This proves how the app responds to each CLI behaviour, not what a real CLI does.

const hoisted = vi.hoisted(() => ({
  userData: { dir: '' },
  sent: [] as Array<{ channel: string; args: unknown[] }>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => hoisted.userData.dir },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send: (channel: string, ...args: unknown[]) => hoisted.sent.push({ channel, args }) },
    }],
  },
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-event-bus', () => ({ emitHookEvent: vi.fn(), emitPtyExit: vi.fn() }));
vi.mock('./pty-manager', () => ({ validateSpawnCwd: vi.fn(async () => undefined) }));

import { IPC } from '../../shared/ipc-channels';
import { summarizeHeadlessTranscript } from '../../shared/headless-transcript';
import { TimelineBuilder } from '../../renderer/features/agents/states/timeline';
import { appLog } from './log-service';
import { isHeadless, kill, spawnHeadless, startStaleSweep, stopStaleSweep } from './headless-manager';

const FAKE_CLI = path.join(__dirname, '__fixtures__', 'fake-headless-cli.mjs');
const AGENT = 'fake-cli-agent';
const SWEEP_MS = 30_000;
const KILL_ESCALATION_MS = 5_000;
const POLL_MS = 10;
const WAIT_POLLS = 400;

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let polls = 0; !condition(); polls++) {
    if (polls >= WAIT_POLLS) throw new Error(`Timed out waiting for ${what}`);
    await realSleep(POLL_MS);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exits(): unknown[][] {
  return hoisted.sent.filter((m) => m.channel === IPC.PTY.EXIT).map((m) => m.args);
}

function hookKinds(): string[] {
  return hoisted.sent
    .filter((m) => m.channel === IPC.AGENT.HOOK_EVENT)
    .map((m) => (m.args[1] as { kind: string }).kind);
}

function logLines(message: string): Array<Record<string, unknown>> {
  return vi.mocked(appLog).mock.calls
    .filter((call) => call[0] === 'core:headless' && call[2] === message)
    .map((call) => (call[3]?.meta ?? {}) as Record<string, unknown>);
}

function cliPid(): number {
  return logLines('Process spawned')[0].pid as number;
}

function transcriptEvents(): unknown[] {
  return fs.readFileSync(path.join(hoisted.userData.dir, 'agent-logs', `${AGENT}.jsonl`), 'utf-8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('headless-manager with a fake CLI (#2813)', () => {
  let holderPidFile: string;
  const spawnedPids: number[] = [];
  const onExit = vi.fn();

  const start = (mode: string) => spawnHeadless(
    AGENT, hoisted.userData.dir, process.execPath, [FAKE_CLI, mode, holderPidFile], undefined, 'stream-json', onExit,
  );
  const holderPid = () => Number(fs.readFileSync(holderPidFile, 'utf-8'));
  const holderStarted = () => fs.existsSync(holderPidFile) && fs.readFileSync(holderPidFile, 'utf-8') !== '';

  beforeEach(() => {
    hoisted.userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-fake-cli-'));
    hoisted.sent.length = 0;
    holderPidFile = path.join(hoisted.userData.dir, 'holder.pid');
    vi.mocked(appLog).mockClear();
    onExit.mockClear();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    startStaleSweep();
  });

  afterEach(async () => {
    stopStaleSweep();
    if (holderStarted()) spawnedPids.push(holderPid());
    if (logLines('Process spawned').length) spawnedPids.push(cliPid());
    for (const pid of spawnedPids.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    // Everything is dead now, so close fires and ends the session.
    await until(() => !isHeadless(AGENT), 'the session to end');
    vi.useRealTimers();
    fs.rmSync(hoisted.userData.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('a normal exit reports at once, with the summary', async () => {
    await start('exit');
    await until(() => exits().length === 1, 'the exit broadcast');

    expect(exits()[0].slice(0, 2)).toEqual([AGENT, 0]);
    expect(isHeadless(AGENT)).toBe(false);
    expect(hookKinds()).toContain('stop');
    await until(() => transcriptEvents().length === 2, 'the transcript');
    expect(summarizeHeadlessTranscript(transcriptEvents()).summary).toBe('all done');
  });

  // Case (a). What the app does today; whether to act on a `result` is an open choice, see #2813.
  it('a result followed by a live process stays a live run until it is stopped', async () => {
    await start('result-then-linger');
    await until(() => hookKinds().includes('stop'), 'the stop hook');

    vi.advanceTimersByTime(SWEEP_MS * 4);

    expect(isHeadless(AGENT)).toBe(true);
    expect(exits()).toEqual([]);
    expect(onExit).not.toHaveBeenCalled();
    expect(isAlive(cliPid())).toBe(true);
    expect(logLines('Headless run still live and quiet').at(-1)).toMatchObject({
      pid: cliPid(),
      resultSeen: true,
      rawEventTypes: { assistant: 1, result: 1 },
    });

    kill(AGENT);
    await until(() => exits().length === 1, 'the exit broadcast');
    expect(exits()[0][1]).toBe(128 + os.constants.signals.SIGTERM);
  });

  // Case (c).
  it('Copilot-shaped events: the exit reports at once, but nothing is understood', async () => {
    await start('copilot-exit');
    await until(() => exits().length === 1, 'the exit broadcast');

    expect(exits()[0].slice(0, 2)).toEqual([AGENT, 0]);
    expect(hookKinds()).toEqual([]);

    await until(() => transcriptEvents().length === 7, 'the transcript');
    const events = transcriptEvents();
    const summary = summarizeHeadlessTranscript(events);
    expect(summary.summary).toBeNull();
    expect(summary.toolCalls).toBe(0);
    expect(summary.filesModified).toEqual([]);

    const timeline = new TimelineBuilder();
    timeline.push(events as never);
    expect(timeline.steps).toEqual([]);
    expect(timeline.totals.summary).toBeNull();
    expect(timeline.eventCount).toBe(7);

    expect(logLines('Process exited')[0]).toMatchObject({
      resultSeen: false,
      rawEventTypes: { 'assistant.message': 1, 'session.shutdown': 1 },
    });
  });

  // The children below hold an inherited pipe open; Windows handle inheritance differs.
  describe.skipIf(process.platform === 'win32')('a child holds stdout open', () => {
    // Case (b).
    it('an exit is missed by close and recovered by the next sweep, once', async () => {
      await start('exit-child-holds-stdout');
      await until(holderStarted, 'the holder');
      await until(() => !isAlive(cliPid()), 'the CLI to exit');
      await realSleep(100);

      expect(isHeadless(AGENT)).toBe(true);
      expect(exits()).toEqual([]);

      vi.advanceTimersByTime(SWEEP_MS);
      expect(isHeadless(AGENT)).toBe(false);
      expect(exits().map((e) => e[1])).toEqual([0]);
      expect(onExit).toHaveBeenCalledTimes(1);

      // The holder ends, so close finally fires. The run has already been reported.
      process.kill(holderPid(), 'SIGKILL');
      await until(() => logLines('Process closed after the stale sweep reported it').length === 1, 'the late close');
      expect(exits()).toHaveLength(1);
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('a CLI killed by a signal is recovered by the sweep too', async () => {
      await start('linger-child-holds-stdout');
      await until(holderStarted, 'the holder');

      kill(AGENT);
      await until(() => !isAlive(cliPid()), 'the CLI to die');
      await realSleep(100);
      expect(exits()).toEqual([]);

      vi.advanceTimersByTime(SWEEP_MS);
      expect(isHeadless(AGENT)).toBe(false);
      expect(exits().map((e) => e[1])).toEqual([128 + os.constants.signals.SIGTERM]);
    });

    it('a CLI that needed SIGKILL still reports its exit', async () => {
      await start('ignore-sigterm-child-holds-stdout');
      await until(holderStarted, 'the holder');

      kill(AGENT);
      await realSleep(100);
      expect(isAlive(cliPid())).toBe(true);

      vi.advanceTimersByTime(KILL_ESCALATION_MS);
      await until(() => !isAlive(cliPid()), 'the CLI to die');
      await realSleep(100);

      vi.advanceTimersByTime(SWEEP_MS);
      expect(exits().map((e) => e[1])).toEqual([128 + os.constants.signals.SIGKILL]);
      expect(isHeadless(AGENT)).toBe(false);
    });
  });
});
