/**
 * Races and transport edges behind the lifecycle contract (#3804) that the
 * per-driver conformance cases cannot reach: a provider closing a permission
 * request while Clubhouse's own answer is in flight, and a Codex request made
 * after app-server has exited.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn() }));
vi.mock('../chat-transcript', () => ({ appendChatEvent: vi.fn(async () => undefined), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { spawn } from 'child_process';
import type { ChatEvent } from '../../../../shared/chat';
import { ChatAgentRuntime } from '../chat-runtime';
import * as permissionQueue from '../../annex-permission-queue';
import { settle } from './conformance-suite';
import { codexConformanceSubject } from './codex-app-server-fake';
import { SCRIPTED_PERSONALITIES, ScriptedProtocolDriver } from './scripted-protocol';

let runtime: ChatAgentRuntime | undefined;

afterEach(async () => {
  await runtime?.stop().catch((): void => undefined);
  runtime = undefined;
  permissionQueue.reset();
});

/** A scripted session with one open permission request whose driver answer waits on `release`. */
async function heldAnswer(agentId: string) {
  const driver = new ScriptedProtocolDriver(SCRIPTED_PERSONALITIES.nativeReceipts);
  const events: ChatEvent[] = [];
  runtime = new ChatAgentRuntime({
    agentId, provider: 'scripted', driverId: driver.id, cwd: 'workspace', level: 'ask', idleTimeoutMs: 0,
    startSession: (resumeNativeSessionId) => driver.start({ agentId, provider: 'scripted', cwd: 'workspace', binaryPath: 'x', level: 'ask', resumeNativeSessionId }),
  });
  runtime.onEvent((e) => { events.push(e); });
  await runtime.start();
  await runtime.sendMessage('edit', { source: 'user', delivery: 'prompt' });
  const session = driver.last;
  session.beginTurn();
  session.requestPermission('p1');
  await vi.waitFor(() => expect(runtime!.getState()).toBe('waiting_permission'));
  let release!: (err?: Error) => void;
  const answered = new Promise<void>((resolve, reject) => { release = (err) => (err ? reject(err) : resolve()); });
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  session.respondPermission = async (requestId, optionId) => {
    session.responses.push({ requestId, optionId });
    entered();
    await answered;
  };
  const resolved = () => events.filter((e): e is Extract<ChatEvent, { type: 'permission_resolved' }> => e.type === 'permission_resolved').map((e) => e.data);
  return { runtime, session, events, release, inFlight, resolved };
}

describe('a provider closing a permission request while Clubhouse answers it', () => {
  it('provider first: the later answer is refused here and never forwarded', async () => {
    const { runtime, session, resolved } = await heldAnswer('race-provider-first');
    session.resolvePermissionNatively('p1', 'cancelled');
    await settle();
    await runtime.respondPermission('p1', 'allow');
    expect(session.responses).toEqual([]);
    expect(resolved()).toEqual([{ requestId: 'p1', decision: 'cancelled', by: 'agent' }]);
    expect(runtime.getPendingPermissionOptions('p1')).toBeUndefined();
    expect(permissionQueue.listPendingForAgent('race-provider-first')).toHaveLength(0);
    expect(runtime.getState()).toBe('running');
  });

  it('answer first, accepted: one resolution, the claimed answer, nothing left open', async () => {
    const { runtime, session, release, inFlight, resolved } = await heldAnswer('race-answer-accepted');
    const answering = runtime.respondPermission('p1', 'allow');
    await inFlight;
    session.resolvePermissionNatively('p1', 'cancelled');
    await settle();
    release();
    await answering;
    await settle();
    expect(resolved()).toEqual([{ requestId: 'p1', optionId: 'allow', decision: 'allow', by: 'user' }]);
    expect(runtime.getPendingPermissionOptions('p1')).toBeUndefined();
    expect(permissionQueue.listPendingForAgent('race-answer-accepted')).toHaveLength(0);
    expect(runtime.getState()).toBe('running');
  });

  it('answer first, refused by the driver after the provider closed it: the provider\'s record stands and the request is not reopened', async () => {
    const { runtime, session, release, inFlight, resolved } = await heldAnswer('race-answer-refused');
    const answering = runtime.respondPermission('p1', 'allow');
    await inFlight;
    session.resolvePermissionNatively('p1', 'cancelled');
    await settle();
    release(new Error('No open permission request p1'));
    await expect(answering).rejects.toThrow('No open permission request p1');
    await settle();
    expect(resolved()).toEqual([{ requestId: 'p1', decision: 'cancelled', by: 'agent' }]);
    expect(runtime.getPendingPermissionOptions('p1')).toBeUndefined();
    expect(permissionQueue.listPendingForAgent('race-answer-refused')).toHaveLength(0);
    expect(runtime.getState()).toBe('running');
    // Not forwarded a second time.
    await runtime.respondPermission('p1', 'allow');
    expect(session.responses).toHaveLength(1);
  });

  it('answer refused with no provider closure: the request stays open for another answer, as before', async () => {
    const { runtime, release, inFlight, resolved } = await heldAnswer('race-refused-alone');
    const answering = runtime.respondPermission('p1', 'allow');
    await inFlight;
    release(new Error('transport busy'));
    await expect(answering).rejects.toThrow('transport busy');
    expect(resolved()).toEqual([]);
    expect(runtime.getPendingPermissionOptions('p1')).toHaveLength(2);
    expect(runtime.getState()).toBe('waiting_permission');
  });

  it('a desktop or Annex decision in flight, refused after the provider closed it: the provider\'s record stands', async () => {
    const { runtime, session, release, inFlight, resolved } = await heldAnswer('race-queue-refused');
    const [entry] = permissionQueue.listPendingForAgent('race-queue-refused');
    permissionQueue.resolvePermission(entry.requestId, 'allow');
    await inFlight;
    session.resolvePermissionNatively('p1', 'cancelled');
    await settle();
    release(new Error('No open permission request p1'));
    await settle();
    expect(resolved()).toEqual([{ requestId: 'p1', decision: 'cancelled', by: 'agent' }]);
    expect(runtime.getPendingPermissionOptions('p1')).toBeUndefined();
    expect(runtime.getState()).toBe('running');
  });
});

describe('Codex requests after app-server has exited', () => {
  it('reject at once instead of waiting out the RPC timeout, and nothing is written', async () => {
    const harness = await codexConformanceSubject(vi.mocked(spawn)).create();
    const session = await harness.driver.start({ agentId: 'codex-exited', provider: 'codex-cli', cwd: 'workspace', binaryPath: 'codex', level: 'ask' });
    const native = harness.native();
    await native.disconnect();
    const started = Date.now();
    const outcome = await Promise.race([
      session.send([{ type: 'text', text: 'after exit' }], 'prompt').then(() => 'resolved', (err: Error) => `rejected: ${err.message}`),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting after 2 s'), 2000)),
    ]);
    expect(outcome).toMatch(/^rejected: /);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(native.received()).toBe(0);
  });
});
