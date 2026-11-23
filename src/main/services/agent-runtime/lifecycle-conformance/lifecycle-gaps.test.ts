/**
 * Current behavior that does not meet the lifecycle contract (#3804), pinned
 * so a fix shows up here as a failing test to rewrite. Each block names what
 * the contract wants; the assertions record what happens today. Nothing here
 * is a waiver: the conformance matrix lists the cases these block.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn() }));
vi.mock('../chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { spawn } from 'child_process';
import type { ActionQueueSettlement, ChatDriver, ChatEvent } from '../../../../shared/chat';
import { ChatAgentRuntime } from '../chat-runtime';
import * as permissionQueue from '../../annex-permission-queue';
import { settle } from './conformance-suite';
import { codexConformanceSubject } from './codex-app-server-fake';
import { SCRIPTED_PERSONALITIES, ScriptedProtocolDriver, scriptedNativeControl } from './scripted-protocol';
import type { NativeControl } from './types';

let runtime: ChatAgentRuntime | undefined;

afterEach(async () => {
  await runtime?.stop().catch((): void => undefined);
  runtime = undefined;
  permissionQueue.reset();
});

async function openRuntime(driver: ChatDriver, agentId: string) {
  const events: ChatEvent[] = [];
  runtime = new ChatAgentRuntime({
    agentId, provider: driver.provider, driverId: driver.id, cwd: 'workspace', level: 'ask', idleTimeoutMs: 0,
    startSession: (resumeNativeSessionId, signal) => driver.start({
      agentId, provider: driver.provider, cwd: 'workspace', binaryPath: 'provider-cli', level: 'ask', resumeNativeSessionId, signal,
    }),
  });
  runtime.onEvent((e) => { events.push(e); });
  await runtime.start();
  await settle();
  return { runtime, events };
}

async function codex(agentId: string): Promise<{ runtime: ChatAgentRuntime; events: ChatEvent[]; native: NativeControl }> {
  const harness = await codexConformanceSubject(vi.mocked(spawn)).create();
  const opened = await openRuntime(harness.driver, agentId);
  return { ...opened, native: harness.native() };
}

/**
 * Contract: a request the provider closed itself (timeout, cancel, answered
 * elsewhere) no longer waits on anyone. Today the runtime writes the
 * provider's permission_resolved but only settles its own record when it
 * answered: the mirrored desktop/Annex queue entry and the pending options
 * stay open past the turn (until the 24 h queue timeout or session end), the
 * state reads waiting_permission for the rest of the turn, and a later answer
 * is still forwarded to the provider. Questions are settled (afterEvent
 * handles question_resolved); permissions have no such case.
 */
describe('gap: a permission request closed by the provider stays pending in Clubhouse', () => {
  it('scripted protocol: queue entry, options and state outlive the provider\'s resolution, and a late answer is forwarded', async () => {
    const driver = new ScriptedProtocolDriver(SCRIPTED_PERSONALITIES.nativeReceipts);
    const { runtime, events } = await openRuntime(driver, 'gap-permission-scripted');
    await runtime.sendMessage('edit', { source: 'user', delivery: 'prompt' });
    driver.last.beginTurn();
    driver.last.requestPermission('p1');
    await settle();
    driver.last.resolvePermissionNatively('p1', 'cancelled');
    await settle();
    expect(events.filter((e) => e.type === 'permission_resolved').map((e) => e.data)).toEqual([{ requestId: 'p1', decision: 'cancelled', by: 'agent' }]);
    expect(runtime.getState()).toBe('waiting_permission');
    expect(runtime.getPendingPermissionOptions('p1')).toHaveLength(2);
    expect(permissionQueue.listPendingForAgent('gap-permission-scripted')).toHaveLength(1);

    driver.last.endTurn('end_turn');
    await settle();
    expect(runtime.getState()).toBe('idle');
    expect(runtime.getPendingPermissionOptions('p1')).toHaveLength(2);
    expect(permissionQueue.listPendingForAgent('gap-permission-scripted')).toHaveLength(1);

    await runtime.respondPermission('p1', 'allow');
    expect(driver.last.responses).toEqual([{ requestId: 'p1', optionId: 'allow' }]);
  });

  it('Codex driver: serverRequest/resolved leaves the same entry, and the late answer fails in the driver', async () => {
    const { runtime, events, native } = await codex('gap-permission-codex');
    await runtime.sendMessage('edit', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await native.requestPermission('ignored');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'permission_request')).toHaveLength(1));
    const request = events.find((e): e is Extract<ChatEvent, { type: 'permission_request' }> => e.type === 'permission_request')!;
    await native.resolvePermissionNatively!(request.data.requestId);
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'permission_resolved')).toHaveLength(1));
    expect(events.find((e) => e.type === 'permission_resolved')!.data).toEqual({ requestId: request.data.requestId, decision: 'cancelled', by: 'agent' });
    await native.endTurn('end_turn');
    await vi.waitFor(() => expect(runtime.getState()).toBe('idle'));
    expect(runtime.getPendingPermissionOptions(request.data.requestId)).toBeDefined();
    expect(permissionQueue.listPendingForAgent('gap-permission-codex')).toHaveLength(1);
    const allow = request.data.options.find((o) => o.kind === 'allow_once')!.optionId;
    await expect(runtime.respondPermission(request.data.requestId, allow)).rejects.toThrow(`No open Codex permission request ${request.data.requestId}`);
  });
});

/**
 * Contract: input held in Clubhouse's own queue when the transport ends was
 * never sent, so it is dropped with the session and never dispatched. Today
 * the Codex driver, on process exit mid-turn, emits a turn_ended of its own
 * ('error'; app-server reported nothing). The runtime cannot tell that from a
 * provider turn end, so it drains the queue: the held item is dispatched into
 * the exited process. The write is dropped (send() skips an unwritable stdin)
 * and the turn/start request waits for the 30 s RPC timeout, while the
 * runtime holds the pump: the session stays running and idle and the item
 * stays unsettled until then. A driver that reports nothing on disconnect
 * (the scripted protocol) drops the item at once.
 */
describe('gap: a driver-local turn end on disconnect drains held input into the exited transport', () => {
  async function holdThenDisconnect(open: () => Promise<{ runtime: ChatAgentRuntime; events: ChatEvent[]; native: NativeControl }>) {
    const { runtime, events, native } = await open();
    const settled: ActionQueueSettlement[] = [];
    await runtime.sendMessage('accepted', { source: 'user', delivery: 'prompt' });
    await native.beginTurn();
    await vi.waitFor(() => expect(runtime.getState()).toBe('running'));
    const held = await runtime.sendMessage('held', { source: 'action', delivery: 'queued', actionQueue: { actionId: 'a', onSettled: (d) => { settled.push(d); } } });
    await native.disconnect();
    await settle(50);
    const statuses = events.filter((e): e is Extract<ChatEvent, { type: 'queue_state' }> => e.type === 'queue_state' && e.data.transition.messageIds.includes(held.messageId!))
      .map((e) => e.data.transition.status);
    return { runtime, events, native, settled, statuses };
  }

  it('Codex driver: the held item is dispatched after the local turn_ended and the session does not end', async () => {
    const { runtime, events, native, settled, statuses } = await holdThenDisconnect(() => codex('gap-drain-codex'));
    const tail = events.slice(events.findIndex((e) => e.type === 'error')).map((e) => e.type === 'turn_ended' ? `turn_ended:${e.data.stopReason}` : e.type);
    expect(tail).toEqual(['error', 'turn_ended:error', 'session_state', 'queue_state']);
    expect(statuses).toEqual(['queued', 'dispatching']);
    expect(native.received()).toBe(1);
    expect(settled).toEqual([]);
    expect(runtime.isRunning()).toBe(true);
    expect(runtime.getState()).toBe('idle');
  });

  it('scripted protocol (reports nothing): the held item is dropped with the session', async () => {
    const { runtime, native, settled, statuses } = await holdThenDisconnect(async () => {
      const driver = new ScriptedProtocolDriver(SCRIPTED_PERSONALITIES.nativeReceipts);
      const opened = await openRuntime(driver, 'gap-drain-scripted');
      return { ...opened, native: scriptedNativeControl(driver.last) };
    });
    expect(statuses).toEqual(['queued']);
    expect(native.received()).toBe(1);
    expect(settled).toEqual(['dropped']);
    expect(runtime.isRunning()).toBe(false);
  });
});
