import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '', deliver: vi.fn(async () => 'delivered' as const) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./agent-config', () => ({ getDurableConfig: vi.fn(async (_path: string, id: string) => ({ id, name: 'Caller' })) }));
vi.mock('./orchestration-policy', () => ({ setOrchestrationPolicy: vi.fn() }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherAgentId: () => false,
  resolveDispatcherIdentity: (projectPath: string, agentId: string) => ({ projectPath, agentId }),
}));
vi.mock('./clubhouse-mcp/tools/helper-delivery', () => ({ deliverHelperUpdate: state.deliver }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-original-answer-'));

import { durableGrantApprovals, invalidateCallApprovalsFor } from './durable-grant-approvals';
import { createDurableCallApprovals, DURABLE_APPROVAL_MAX_BYTES } from './durable-call-approvals';
import { answerGrantRequest } from './grant-request-answers';
import { runGrantCommand } from './mobile-grant-requests';
import { _resetGrantRequestsForTesting, callKey, consumeCallApprovalScope, peekGrantRequest, readOriginalAllowedCall, recordGrantRequest } from './grant-requests';
import { deliveryHash } from './annex-delivery-store';
import { withSettingsSurface } from './settings-audit';
import { effectiveAgentGrants, setAgentGrant } from './agent-grants-service';
import { agentGrantChangePending, withAgentGrantChange } from './agent-grants-store';
import { evaluateGrant } from '../../shared/agent-grants';
import { GRANT_OFF_PERSISTENCE_FAILED } from '../../shared/agent-grant-changes';
import { checkToolGrant } from './clubhouse-mcp/grant-check';
import { GRANT_REQUEST_TTL_MS } from '../../shared/grant-requests';

const now = Date.UTC(2026, 10, 12, 12);
const machine = Array(16).fill('aa').join(':');
let sequence = 0;
const fixture = (knownCaller?: string) => {
  const index = ++sequence;
  const callerId = knownCaller ?? `caller-${index}`;
  const commandId = `command-${index}`;
  const args = { machine: 'Mac', request: 'Handle this exact request' };
  const key = callKey(callerId, 'hand_off_request', args);
  const wire = {
    v: 1, callId: `delivery-${index}`, from: { agentId: callerId, name: 'Caller', projectName: 'Project' },
    to: 'controller', tool: 'hand_off_request', protocol: 'federation', commandId,
    args: { request: args.request, origin: { requestId: commandId } }, context: { rootId: commandId, depth: 0 },
    epoch: { sender: 'sender-pairing', receiver: 'receiver-pairing' },
  };
  const intent = durableGrantApprovals.prepare({
    callerId, callKey: key, toolName: 'hand_off_request', protocol: 'federation', operation: 'hand_off_request',
    machineId: machine, targetId: 'controller', epoch: wire.epoch, displayTarget: 'Dispatcher on Mac', policyContext: deliveryHash({ mode: 'ask', policy: index }),
  }, deliveryHash(wire), [{ action: 'agent.message', where: 'Dispatcher on Mac' }], commandId, now);
  const recorded = recordGrantRequest(key, {
    kind: 'call', agentId: callerId, agentName: 'Caller', projectPath: '/project', actions: ['agent.message'],
    where: 'Dispatcher on Mac', toolName: 'hand_off_request', argumentsText: JSON.stringify(args),
  }, now, intent.scope);
  if (!recorded.ok) throw new Error('Request not recorded');
  const requestId = recorded.request.requestId;
  const native = (allow = true) => withSettingsSurface('ui', undefined, () => answerGrantRequest(requestId, allow));
  const mobile = (assertAuthorized = vi.fn()) => runGrantCommand({
    version: 1, commandId: `phone-${index}`, epoch: 'phone-epoch', type: 'grant.answer', requestId, answer: 'allow_once',
  }, { projects: [{ id: 'project', path: '/project' }], dispatcher: null }, { viewer: 'phone', assertAuthorized });
  return { callerId, key, intent, requestId, native, mobile };
};
const restart = () => createDurableCallApprovals(() => undefined);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  state.deliver.mockClear();
});
afterEach(() => {
  _resetGrantRequestsForTesting();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => fs.rmSync(state.base, { recursive: true, force: true }));

describe('actual native/mobile original-call answers (transport not activated)', () => {
  it('native Allow persists the pre-click original before success and never creates ephemeral durable authority', async () => {
    const f = fixture();
    expect(await f.native()).toEqual({ ok: true });
    const original = restart().findUnclaimedForCall(f.key, now);
    expect(original?.reference).toEqual({ requestId: f.requestId });
    expect(original?.intent).toEqual(f.intent);
    expect(readOriginalAllowedCall(f.requestId)).toBeUndefined();
    expect(consumeCallApprovalScope(f.key)).toBeNull();
    expect(await durableGrantApprovals.claim({ requestId: f.requestId }, f.intent, 'ask')).toEqual({ allowed: true });
    expect(restart().verify({ requestId: f.requestId }, f.intent, 'ask')).toEqual({ allowed: true });
    expect(restart().findUnclaimedForCall(f.key)).toBeUndefined();
  });

  it('authorized phone uses the same original-answer path and rechecks authorization when the write starts', async () => {
    const f = fixture();
    const authorized = vi.fn();
    expect(await f.mobile(authorized)).toMatchObject({ requestId: f.requestId, answer: 'allow_once' });
    expect(authorized).toHaveBeenCalledTimes(2);
    expect(restart().findUnclaimedForCall(f.key)?.intent).toEqual(f.intent);
    expect(consumeCallApprovalScope(f.key)).toBeNull();
  });

  it('a prepared context, request id, surface, or declined answer cannot issue a receipt', async () => {
    const f = fixture();
    await expect(withSettingsSurface('ui', undefined, () => durableGrantApprovals.approveAnsweredRequest(f.requestId))).rejects.toMatchObject({ code: 'approval_not_original' });
    expect(await f.native(false)).toEqual({ ok: true });
    await expect(durableGrantApprovals.approveAnsweredRequest(f.requestId)).rejects.toMatchObject({ code: 'approval_not_original' });
    expect(restart().findUnclaimedForCall(f.key)).toBeUndefined();
    expect(consumeCallApprovalScope(f.key)).toBeNull();
  });

  it('native persistence failure restores the original request, tells nobody it succeeded, and can be clicked again', async () => {
    const f = fixture();
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('approval write failed'));
    expect(await f.native()).toEqual({ ok: false, error: 'approval write failed' });
    expect(peekGrantRequest(f.requestId)?.requestId).toBe(f.requestId);
    expect(readOriginalAllowedCall(f.requestId)).toBeUndefined();
    expect(restart().findUnclaimedForCall(f.key)).toBeUndefined();
    expect(consumeCallApprovalScope(f.key)).toBeNull();
    expect(state.deliver).not.toHaveBeenCalled();
    expect(await f.native()).toEqual({ ok: true });
    expect(restart().findUnclaimedForCall(f.key)?.intent).toEqual(f.intent);
    expect(state.deliver).toHaveBeenCalledTimes(1);
  });

  it('mobile persistence failure is a rejected receipt, not a reported successful approval', async () => {
    const f = fixture();
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('phone approval write failed'));
    await expect(f.mobile()).rejects.toMatchObject({ code: 'grant_answer_failed' });
    expect(peekGrantRequest(f.requestId)).not.toBeNull();
    expect(restart().findUnclaimedForCall(f.key)).toBeUndefined();
    expect(state.deliver).not.toHaveBeenCalled();
  });

  it('missing original preparation refuses the actual click rather than minting from current policy', async () => {
    const f = fixture();
    await invalidateCallApprovalsFor(f.callerId);
    const result = await f.native();
    expect(result.ok).toBe(false);
    expect(peekGrantRequest(f.requestId)).not.toBeNull();
    expect(restart().findUnclaimedForCall(f.key)).toBeUndefined();
    expect(consumeCallApprovalScope(f.key)).toBeNull();
    expect(state.deliver).not.toHaveBeenCalled();
  });

  it('a native/phone double answer can persist only the first actual original decision', async () => {
    const f = fixture();
    const native = f.native();
    await expect(f.mobile()).rejects.toMatchObject({ code: 'grant_request_not_found' });
    expect(await native).toEqual({ ok: true });
    const raw = JSON.parse(fs.readFileSync(path.join(state.base, 'durable-call-approvals.json'), 'utf8'));
    expect(raw.receipts.filter((entry: { requestId: string }) => entry.requestId === f.requestId)).toHaveLength(1);
    expect(state.deliver).toHaveBeenCalledTimes(1);
  });

  it('neither proof nor a successful answer is visible while the durable write is unfinished', async () => {
    const f = fixture();
    const rename = fs.promises.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { await gate; return rename(from, to); });
    const answer = f.native();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(readOriginalAllowedCall(f.requestId)?.scope).toEqual(f.intent.scope);
    expect(consumeCallApprovalScope(f.key)).toBeNull();
    expect(restart().findUnclaimedForCall(f.key)).toBeUndefined();
    expect(state.deliver).not.toHaveBeenCalled();
    release();
    expect(await answer).toEqual({ ok: true });
    expect(restart().findUnclaimedForCall(f.key)?.intent).toEqual(f.intent);
  });

  it('revoking phone control while its answer waits behind another write prevents any approval', async () => {
    const first = fixture();
    const phone = fixture();
    const rename = fs.promises.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => { await gate; return rename(from, to); });
    const firstAnswer = first.native();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    let authorized = true;
    const secondAnswer = phone.mobile(() => { if (!authorized) throw new Error('Phone no longer controls this machine'); });
    const rejected = expect(secondAnswer).rejects.toMatchObject({ code: 'grant_answer_failed' });
    authorized = false;
    release();
    expect(await firstAnswer).toEqual({ ok: true });
    await rejected;
    expect(peekGrantRequest(phone.requestId)).not.toBeNull();
    expect(restart().findUnclaimedForCall(phone.key)).toBeUndefined();
    expect(consumeCallApprovalScope(phone.key)).toBeNull();
  });

  it('awaited policy invalidation survives restart and cannot be bypassed by an old reference', async () => {
    const f = fixture();
    await f.native();
    const reference = { requestId: f.requestId };
    await durableGrantApprovals.claim(reference, f.intent, 'ask');
    await invalidateCallApprovalsFor(f.callerId);
    expect(restart().verify(reference, f.intent, 'refuse')).toEqual({ allowed: false, reason: 'grant_refused' });
    expect(restart().verify(reference, f.intent, 'ask')).toEqual({ allowed: false, reason: 'approval_revoked' });
  });

  it('a native approval arriving during a pending policy operation cannot issue new proof', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const changing = withAgentGrantChange(f.callerId, () => gate);
    expect(await f.native()).toMatchObject({ ok: false });
    expect(consumeCallApprovalScope(f.key)).toBeNull();
    expect(restart().findUnclaimedForCall(f.key)).toBeUndefined();
    expect(peekGrantRequest(f.requestId)).not.toBeNull();
    release();
    await changing;
  });

  it('pending Off gates real calls before revocation settles and rejects an overlapping native approval', async () => {
    const callerId = `overlap-caller-${++sequence}`;
    const grant = { action: 'agent.message' as const, target: { kind: 'remote_dispatcher' as const } };
    await setAgentGrant('/project', callerId, { ...grant, mode: 'ask' });
    const approved = fixture(callerId);
    await approved.native();
    const waiting = fixture(callerId);
    const rename = fs.promises.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { await gate; return rename(from, to); });
    const changing = setAgentGrant('/project', callerId, { ...grant, mode: 'off' });
    expect(agentGrantChangePending(callerId)).toBe(true);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(checkToolGrant(callerId, { actions: ['agent.message'], target: 'remote_dispatcher' }, {})).toMatchObject({ ok: false, reason: 'no_grant' });
    const answering = waiting.native();
    release();
    expect(await changing).not.toHaveProperty('partialFailure');
    expect(await answering).toMatchObject({ ok: false });
    expect(restart().findUnclaimedForCall(waiting.key)).toBeUndefined();
    expect(consumeCallApprovalScope(waiting.key)).toBeNull();
  });

  it.each(['receipt', 'policy', 'both'] as const)('actual %s storage failure gives truthful Off/restart behavior and blocks later widening', async (failure) => {
    const callerId = `policy-caller-${++sequence}`;
    const grant = { action: 'agent.message' as const, target: { kind: 'remote_dispatcher' as const } };
    await setAgentGrant('/project', callerId, { ...grant, mode: 'ask' });
    const f = fixture(callerId);
    await f.native();
    const reference = { requestId: f.requestId };
    await durableGrantApprovals.claim(reference, f.intent, 'ask');
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      const file = String(to);
      if ((failure === 'receipt' || failure === 'both') && file.endsWith('durable-call-approvals.json')) throw new Error('receipt storage failed');
      if ((failure === 'policy' || failure === 'both') && file.endsWith('agent-grants.json')) throw new Error('policy storage failed');
      return rename(from, to);
    });
    const changing = setAgentGrant('/project', callerId, { ...grant, mode: 'off' });
    if (failure === 'receipt') {
      expect(await changing).toMatchObject({ partialFailure: { code: 'approval_revocation_failed', effectiveOff: true } });
      await expect(setAgentGrant('/project', callerId, { ...grant, mode: 'ask' })).rejects.toThrow('receipt storage failed');
      await expect(setAgentGrant('/project', callerId, { ...grant, mode: 'allow' })).rejects.toThrow('receipt storage failed');
    } else await expect(changing).rejects.toThrow(failure === 'both' ? GRANT_OFF_PERSISTENCE_FAILED : 'policy storage failed');
    const fresh = evaluateGrant({
      caller: { kind: 'agent', agentId: callerId, projectPath: '/project' }, action: grant.action,
      target: { kind: 'agent', isDispatcher: true, isRemoteDispatcher: true },
    }, await effectiveAgentGrants('/project', callerId));
    expect(fresh.outcome).toBe(failure === 'receipt' ? 'refuse' : 'ask');
    const savedPolicy = JSON.parse(fs.readFileSync(path.join(state.base, 'agent-grants.json'), 'utf8'));
    expect(savedPolicy.agents[callerId]?.changes.some((change: { mode: string }) => change.mode === 'ask') ?? false).toBe(failure !== 'receipt');
    expect(durableGrantApprovals.verify(reference, f.intent, 'ask')).toEqual({ allowed: false, reason: 'approval_revoked' });
    expect(restart().verify(reference, f.intent, failure === 'receipt' ? 'refuse' : 'ask')).toEqual(
      failure === 'receipt' ? { allowed: false, reason: 'grant_refused' }
        : failure === 'policy' ? { allowed: false, reason: 'approval_revoked' } : { allowed: true },
    );
    expect(agentGrantChangePending(callerId)).toBe(false);
  });

  it('saves truthful restrictive Off when full-ledger revocation cannot fit and blocks later widening', async () => {
    const callerId = `capacity-caller-${++sequence}`;
    const grant = { action: 'agent.message' as const, target: { kind: 'remote_dispatcher' as const } };
    await setAgentGrant('/project', callerId, { ...grant, mode: 'ask' });
    const key = callKey(callerId, 'hand_off_request', { request: 'original' });
    const intent = durableGrantApprovals.prepare({
      callerId, callKey: key, toolName: 'hand_off_request', protocol: 'federation', operation: 'hand_off_request',
      machineId: machine, targetId: 'controller', epoch: { sender: 'sender-pairing', receiver: 'receiver-pairing' },
      displayTarget: 'Dispatcher on Mac', policyContext: deliveryHash({ mode: 'ask' }),
    }, deliveryHash({ request: 'original' }), [
      { action: 'agent.message', where: 'x'.repeat(1_000) }, { action: 'agent.read', where: 'y'.repeat(100) },
    ], 'capacity-command', now);
    const recorded = recordGrantRequest(key, {
      kind: 'call', agentId: callerId, agentName: 'Caller', projectPath: '/project',
      actions: ['agent.message', 'agent.read'], where: 'Dispatcher on Mac', toolName: 'hand_off_request',
    }, now, intent.scope);
    if (!recorded.ok) throw new Error('Request not recorded');
    expect(await answerGrantRequest(recorded.request.requestId, true)).toEqual({ ok: true });
    await durableGrantApprovals.claim({ requestId: recorded.request.requestId }, intent, 'ask', now);
    const file = path.join(state.base, 'durable-call-approvals.json');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8')).receipts.find((entry: { requestId: string }) => entry.requestId === recorded.request.requestId);
    const seed = { version: 1, receipts: Array.from({ length: 2_000 }, (_, index) => ({ ...receipt, requestId: `seed-${index}` })) };
    const before = JSON.stringify(seed);
    expect(Buffer.byteLength(before)).toBeLessThan(DURABLE_APPROVAL_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(seed, null, 2))).toBeGreaterThan(DURABLE_APPROVAL_MAX_BYTES);
    fs.writeFileSync(file, before);
    vi.resetModules();
    const freshPolicy = await import('./agent-grants-service');
    const freshProof = await import('./durable-grant-approvals');
    expect(await freshPolicy.setAgentGrant('/project', callerId, { ...grant, mode: 'off' })).toMatchObject({
      partialFailure: { code: 'approval_revocation_failed', effectiveOff: true },
    });
    await expect(freshPolicy.setAgentGrant('/project', callerId, { ...grant, mode: 'allow' })).rejects.toMatchObject({ code: 'approval_store_full' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(freshProof.durableGrantApprovals.verify({ requestId: 'seed-0' }, intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_revoked' });
    expect(restart().verify({ requestId: 'seed-0' }, intent, 'ask', now)).toEqual({ allowed: true });
    expect(restart().verify({ requestId: 'seed-0' }, intent, 'refuse', now)).toEqual({ allowed: false, reason: 'grant_refused' });
    expect(evaluateGrant({
      caller: { kind: 'agent', agentId: callerId, projectPath: '/project' }, action: grant.action,
      target: { kind: 'agent', isDispatcher: true, isRemoteDispatcher: true },
    }, await freshPolicy.effectiveAgentGrants('/project', callerId)).outcome).toBe('refuse');
    expect(receipt.claimBy).toBe(now + GRANT_REQUEST_TTL_MS);
  });
});
