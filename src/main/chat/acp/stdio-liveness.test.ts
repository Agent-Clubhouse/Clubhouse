/**
 * Registration gate 2 (README, "Before registration"): what happens, with a
 * real child process on every platform, when an established agent stops
 * reading its stdin but keeps running.
 *
 * Nothing breaks the pipe here (unlike stdio.test.ts's stop-reading case,
 * which closes fd 0 and is POSIX only), so no write ever fails and the
 * transport sees no error. The contract this proves:
 *
 * - The open turn stays open: no turn_ended is made up, nothing is resent.
 * - interrupt() returns, but settles nothing: session/cancel is only written.
 * - Stop (close()) is the bound. It ends the owned process within the stop
 *   path's own limits (session/close timeout, then kill with its grace), the
 *   transport ends, the turn's outcome stays unknown, and a later send is
 *   refused locally.
 *
 * Limitation, by design: until the person stops it, an agent that stops
 * reading while alive keeps its turn running; there's no prompt timeout.
 * A steer written to it is reported as 'steer' when written, though the agent
 * never reads it. Native Windows evidence needs a hosted windows-latest run.
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession } from '../../../shared/chat/runtime';
import { createAcpChatDriver, type AcpLaunchSpec } from './driver';

const AGENT = path.join(__dirname, 'testing', 'stdio-agent.mjs');
const SPEC: AcpLaunchSpec = { id: 'acp_neutral_test' as ChatDriverId, provider: 'acp-test', args: () => [AGENT] };

/** session/close timeout plus the kill grace (stdio.ts), plus taskkill's own limit on Windows. */
const STOP_BOUND_MS = 5_000 + 5_000 + 5_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function establishedAndStopped(spec: AcpLaunchSpec) {
  const driver = createAcpChatDriver(spec, { timeouts: { closeMs: 5_000 } });
  const session = await driver.start({ agentId: 'a', provider: 'acp-test', cwd: __dirname, binaryPath: process.execPath, level: 'ask' });
  expect(session.nativeSessionId).toBe('stdio-1');
  const drafts: ChatEventDraft[] = [];
  let ended = false;
  const done = (async () => { for await (const d of session.events) drafts.push(d); ended = true; })();
  await session.send([{ type: 'text', text: 'stop-reading-alive' }], 'prompt');
  await vi.waitFor(() => expect(drafts.some((d) => d.type === 'agent_message_chunk')).toBe(true), { timeout: 5_000 });
  const chunk = drafts.find((d) => d.type === 'agent_message_chunk') as Extract<ChatEventDraft, { type: 'agent_message_chunk' }>;
  const pid = Number(/^pid:(\d+)$/.exec(chunk.data.text)?.[1]);
  expect(pid).toBeGreaterThan(0);
  return { session, drafts, done, pid, isEnded: () => ended };
}

async function stopAndCheck(session: ChatDriverSession, drafts: ChatEventDraft[], done: Promise<void>, pid: number) {
  const before = Date.now();
  await session.close();
  await done;
  const took = Date.now() - before;
  expect(took).toBeLessThan(STOP_BOUND_MS);
  // The owned process is gone, not just the pipe.
  await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5_000 });
  // No outcome made up for the open turn, and nothing more was said.
  expect(drafts.filter((d) => d.type === 'turn_ended')).toEqual([]);
  expect(drafts.filter((d) => d.type === 'turn_started')).toHaveLength(1);
  // A stop the person asked for isn't reported as the agent exiting.
  expect(drafts.filter((d) => d.type === 'error')).toEqual([]);
  await expect(session.send([{ type: 'text', text: 'again' }], 'prompt')).rejects.toThrow(/not open/);
  return took;
}

describe('an established ACP agent that stops reading but stays alive (real process)', () => {
  it('interrupt settles nothing; Stop ends the process in bounded time with the turn unknown', async () => {
    const { session, drafts, done, pid, isEnded } = await establishedAndStopped(SPEC);
    // Interrupt: session/cancel is written into an unread pipe. It returns, but the turn stays open.
    await session.interrupt();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(isEnded()).toBe(false);
    expect(drafts.filter((d) => d.type === 'turn_ended')).toEqual([]);
    expect(session.isClosed?.()).toBe(false);
    expect(isAlive(pid)).toBe(true);
    await stopAndCheck(session, drafts, done, pid);
  }, 30_000);

  it('Stop without an interrupt first ends it the same way', async () => {
    const { session, drafts, done, pid } = await establishedAndStopped(SPEC);
    await stopAndCheck(session, drafts, done, pid);
  }, 30_000);

  it('with the steer claim: a steer is written (not read), and Stop leaves both prompts unknown', async () => {
    const { session, drafts, done, pid } = await establishedAndStopped({ ...SPEC, claims: { steer: true } });
    // Larger than a pipe buffer, so on every platform the write can only be queued, never read.
    const big = 'x'.repeat(256 * 1024);
    expect(await session.send([{ type: 'text', text: big }], 'steer')).toBe('steer');
    await new Promise((r) => setTimeout(r, 500));
    expect(drafts.filter((d) => d.type === 'turn_ended')).toEqual([]);
    expect(drafts.filter((d) => d.type === 'notice')).toEqual([]);
    await stopAndCheck(session, drafts, done, pid);
  }, 30_000);
});
