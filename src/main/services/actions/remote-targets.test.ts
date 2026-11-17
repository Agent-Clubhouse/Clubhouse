import { beforeEach, expect, it, vi } from 'vitest';
const machine = 'aa:'.repeat(15) + 'aa';
const target = `worker@${machine}`;
const mocks = vi.hoisted(() => ({ satellite: vi.fn(), direction: vi.fn(), forward: vi.fn(), receipt: vi.fn() }));
vi.mock('../dispatcher-federation', () => ({ remoteFederationController: () => undefined }));
vi.mock('../annex-client', () => ({ getSatellite: mocks.satellite }));
vi.mock('../annex-agent-calls', () => ({ isNetworkComputer: () => true, forwardPreparedAgentCall: mocks.forward, getDelivery: mocks.receipt }));
vi.mock('../annex-identity', () => ({ getIdentity: () => undefined }));
vi.mock('../connection-grants-store', () => ({ getConnectionDirection: mocks.direction }));
import { canonicalActionReference, remoteMessageRefusal, sendRemoteActionMessage } from './remote-targets';
import { createStepRunner, type StepDeps } from './steps';
import type { StepContext } from './engine';
const ctx: StepContext = { action: { id: 'a', name: 'test', owner: { kind: 'agent', agentId: 'owner' }, enabled: true, trigger: { kind: 'once', at: 1 }, steps: [], overlap: 'skip', createdAt: 0, updatedAt: 0 }, runId: 'r', stepIndex: 0, chain: ['a'] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.satellite.mockReturnValue({ state: 'connected', alias: 'Laptop', snapshot: { agents: { p: [{ id: 'worker', name: 'Worker', kind: 'durable' }] } } });
  mocks.direction.mockReturnValue({ link: true, disabledTools: [] });
  mocks.forward.mockImplementation(async (...args: unknown[]) => { (args[7] as (id: string) => void)('d1'); return { content: [{ type: 'text', text: 'Accepted' }] }; });
  mocks.receipt.mockReturnValue({ callId: 'd1', state: 'queued' });
});
it('canonicalizes renderer references', () => expect(canonicalActionReference(`remote||${machine}||worker`)).toBe(target));
it('accepts connected ordinary agents and refuses offline/unknown/Dispatcher targets', () => {
  expect(remoteMessageRefusal('owner', target)).toBeNull();
  mocks.satellite.mockReturnValueOnce({ state: 'disconnected' });
  expect(remoteMessageRefusal('owner', target)).toMatch(/offline/i);
  expect(remoteMessageRefusal('owner', `missing@${machine}`)).toMatch(/unknown/i);
  const sat = mocks.satellite(); sat.snapshot.dispatcher = { agent: { id: 'worker' } };
  expect(remoteMessageRefusal('owner', target)).toMatch(/Dispatcher/);
});
it('refuses a removed connection or disabled send_message tool', () => {
  mocks.direction.mockReturnValueOnce(undefined);
  expect(remoteMessageRefusal('owner', target)).toMatch(/connection/);
  mocks.direction.mockReturnValueOnce({ link: true, disabledTools: ['send_message'] });
  expect(remoteMessageRefusal('owner', target)).toMatch(/send_message/);
});
it('forwards as the real owner with identical run/step keys on retries and trusted causation', async () => {
  await sendRemoteActionMessage(target, 'hello', ctx);
  await sendRemoteActionMessage(target, 'hello', ctx);
  const first = mocks.forward.mock.calls[0];
  expect(first.slice(0, 4)).toEqual(['owner', target, 'Worker on Laptop', 'send_message']);
  expect(first[4]).toMatchObject({ message: 'hello', task_id: expect.any(String), idempotency_key: expect.any(String) });
  expect(mocks.forward.mock.calls[1][4]).toEqual(first[4]);
  expect(first[6]).toMatchObject({ rootId: expect.any(String), depth: 1 });
  await sendRemoteActionMessage(target, 'hello', { ...ctx, stepIndex: 1 });
  expect(mocks.forward.mock.calls[2][4].idempotency_key).not.toBe(first[4].idempotency_key);
});
it('branches before any local lifecycle/runtime lookup and retains a durable receipt', async () => {
  const forbidden = vi.fn(() => { throw new Error('local path'); });
  const runner = createStepRunner({ agentExists: forbidden, agentName: forbidden, isRunning: forbidden, wake: forbidden, remoteMessage: sendRemoteActionMessage } as unknown as StepDeps);
  expect(await runner.run({ kind: 'message', agentId: target, text: 'hello' }, ctx)).toMatchObject({ outcome: 'done', remoteDelivery: { callId: 'd1', state: 'queued' } });
  expect(forbidden).not.toHaveBeenCalled();
  expect(await runner.run({ kind: 'wake', agentId: target }, ctx)).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/message/) });
  expect(await runner.run({ kind: 'sleep', agentId: target }, ctx)).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/message/) });
});

it('preserves immediate delivered/refused/indeterminate receipt states without parsing result text', async () => {
  for (const state of ['delivered', 'refused', 'indeterminate'] as const) {
    mocks.receipt.mockReturnValueOnce({ callId: 'd1', state });
    const result = await sendRemoteActionMessage(target, 'hello', ctx);
    expect(result.remoteDelivery?.state).toBe(state);
    expect(result.outcome).toBe(state === 'delivered' ? 'done' : 'failed');
    if (state === 'delivered') expect(result.detail).toContain('accepted by the remote runtime');
  }
});
it('uses the Dispatcher identity and never substitutes it for user/group ownership', async () => {
  await sendRemoteActionMessage(target, 'hello', { ...ctx, action: { ...ctx.action, owner: { kind: 'dispatcher' } }, dispatcherAgentId: 'controller' });
  expect(mocks.forward.mock.calls[0][0]).toBe('controller');
  expect(await sendRemoteActionMessage(target, 'hello', { ...ctx, action: { ...ctx.action, owner: { kind: 'user' } } })).toMatchObject({ outcome: 'failed' });
  expect(mocks.forward).toHaveBeenCalledTimes(1);
});
