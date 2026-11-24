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
 *   (The composer's Stop button, Esc, is this interrupt: it keeps the session.)
 * - session.close() is the bound. It is what the agent's Stop action runs
 *   (row menu or toolbar Stop, and Annex agent stop: killAgent →
 *   ChatAgentRuntime.stop → session.close). It ends the owned process within
 *   the stop path's own limits (session/close timeout, then kill with its
 *   grace), the transport ends, the turn's outcome stays unknown, and a later
 *   send is refused locally.
 *
 * Limitation, by design: until the person stops the agent, one that stops
 * reading while alive keeps its turn running; there's no prompt timeout, and
 * the composer's Stop doesn't end it. A steer written to it is reported as
 * 'steer' once written, though the agent never reads it. Native Windows
 * evidence needs a hosted windows-latest run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession } from '../../../shared/chat/runtime';
import type { ChildProcess } from 'child_process';
import { createAcpChatDriver, type AcpLaunchSpec } from './driver';
import { stdioConnector } from './stdio';

const AGENT = path.join(__dirname, 'testing', 'stdio-agent.mjs');
const SPEC: AcpLaunchSpec = { id: 'acp_neutral_test' as ChatDriverId, provider: 'acp-test', args: () => [AGENT] };

/** session/close timeout plus the kill grace (stdio.ts), plus taskkill's own limit on Windows. */
const STOP_BOUND_MS = 5_000 + 5_000 + 5_000;

/**
 * The sessions and child processes each test created, registered the moment
 * they exist and cleaned up after the test whatever happened. Children are
 * held by their ChildProcess handle, so cleanup only ever signals the process
 * this test spawned (Node won't signal a child it has seen exit), never a pid
 * that may have been reused. Cleanup runs after the test's own assertions,
 * including the ones that the process exited, so it can't turn a failure
 * green, and its own errors don't replace the test's.
 */
const owned: { sessions: ChatDriverSession[]; children: ChildProcess[] } = { sessions: [], children: [] };

afterEach(async () => {
  const { sessions, children } = owned;
  owned.sessions = [];
  owned.children = [];
  await Promise.allSettled(sessions.map((s) => s.close()));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function establishedAndStopped(spec: AcpLaunchSpec) {
  let child: ChildProcess | undefined;
  const driver = createAcpChatDriver(spec, {
    timeouts: { closeMs: 5_000 },
    // The driver's own stdio transport; the hook only hands the test its child.
    connect: (command, opts) => stdioConnector({ command, ...opts, onSpawn: (c) => { child = c; owned.children.push(c); } }),
  });
  const session = await driver.start({ agentId: 'a', provider: 'acp-test', cwd: __dirname, binaryPath: process.execPath, level: 'ask' });
  owned.sessions.push(session);
  expect(session.nativeSessionId).toBe('stdio-1');
  const drafts: ChatEventDraft[] = [];
  let ended = false;
  const done = (async () => { for await (const d of session.events) drafts.push(d); ended = true; })();
  await session.send([{ type: 'text', text: 'stop-reading-alive' }], 'prompt');
  await vi.waitFor(() => expect(drafts.some((d) => d.type === 'agent_message_chunk')).toBe(true), { timeout: 5_000 });
  const chunk = drafts.find((d) => d.type === 'agent_message_chunk') as Extract<ChatEventDraft, { type: 'agent_message_chunk' }>;
  // The process that stopped reading is the one this session spawned.
  expect(child).toBeDefined();
  expect(Number(/^pid:(\d+)$/.exec(chunk.data.text)?.[1])).toBe(child!.pid);
  return { session, drafts, done, child: child!, isEnded: () => ended };
}

async function stopAndCheck(session: ChatDriverSession, drafts: ChatEventDraft[], done: Promise<void>, child: ChildProcess) {
  const before = Date.now();
  await session.close();
  await done;
  const took = Date.now() - before;
  expect(took).toBeLessThan(STOP_BOUND_MS);
  // The owned process has exited, not just its pipe: close() waits for its 'close' event.
  expect(exited(child)).toBe(true);
  // No outcome made up for the open turn, and nothing more was said.
  expect(drafts.filter((d) => d.type === 'turn_ended')).toEqual([]);
  expect(drafts.filter((d) => d.type === 'turn_started')).toHaveLength(1);
  // A stop the person asked for isn't reported as the agent exiting.
  expect(drafts.filter((d) => d.type === 'error')).toEqual([]);
  await expect(session.send([{ type: 'text', text: 'again' }], 'prompt')).rejects.toThrow(/not open/);
  return took;
}

describe('an established ACP agent that stops reading but stays alive (real process)', () => {
  it('interrupt (composer Stop) settles nothing; close (agent Stop) ends the process in bounded time with the turn unknown', async () => {
    const { session, drafts, done, child, isEnded } = await establishedAndStopped(SPEC);
    // Interrupt: session/cancel is written into an unread pipe. It returns, but the turn stays open.
    await session.interrupt();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(isEnded()).toBe(false);
    expect(drafts.filter((d) => d.type === 'turn_ended')).toEqual([]);
    expect(session.isClosed?.()).toBe(false);
    expect(exited(child)).toBe(false);
    await stopAndCheck(session, drafts, done, child);
  }, 30_000);

  it('close without an interrupt first ends it the same way', async () => {
    const { session, drafts, done, child } = await establishedAndStopped(SPEC);
    await stopAndCheck(session, drafts, done, child);
  }, 30_000);

  it('with the steer claim: a steer to the stopped reader is reported written, and close leaves both prompts unknown', async () => {
    const { session, drafts, done, child, isEnded } = await establishedAndStopped({ ...SPEC, claims: { steer: true } });
    // Observed state only: the write raises nothing and the transport stays
    // up, so the driver reports the steer as written. Whether the bytes sit
    // in the OS pipe or in Node's queue isn't asserted.
    expect(await session.send([{ type: 'text', text: 'also this' }], 'steer')).toBe('steer');
    await new Promise((r) => setTimeout(r, 500));
    expect(isEnded()).toBe(false);
    expect(session.isClosed?.()).toBe(false);
    expect(drafts.filter((d) => d.type === 'turn_ended')).toEqual([]);
    expect(drafts.filter((d) => d.type === 'notice')).toEqual([]);
    await stopAndCheck(session, drafts, done, child);
  }, 30_000);
});
