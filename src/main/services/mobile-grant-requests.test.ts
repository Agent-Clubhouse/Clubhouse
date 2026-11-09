import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setAgentGrant: vi.fn(async (..._args: unknown[]) => ({ rows: [] })),
  deliver: vi.fn(async (..._args: unknown[]) => 'delivered' as const),
  audit: [] as Array<{ agentId: string; kind: string; outcome: string; surface: string }>,
}));
vi.mock('./agent-grants-service', () => ({ setAgentGrant: mocks.setAgentGrant }));
vi.mock('./clubhouse-mcp/tools/helper-delivery', () => ({ deliverHelperUpdate: mocks.deliver }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./grant-telemetry', async () => {
  const { currentSettingsOrigin } = await import('./settings-audit');
  return {
    recordGrantRequest: (input: { agentId: string; kind: string; outcome: string }) => {
      mocks.audit.push({ agentId: input.agentId, kind: input.kind, outcome: input.outcome, surface: currentSettingsOrigin().surface });
    },
  };
});

import { buildMobileGrantRequests, runGrantCommand, type GrantRequestPlaces } from './mobile-grant-requests';
import { answerGrantRequest } from './grant-request-answers';
import {
  _resetGrantRequestsForTesting, callKey, consumeCallApproval, listGrantRequests, onGrantRequestsChanged, recordGrantRequest, type GrantRequestChange,
} from './grant-requests';
import { MobileCommandService, MobileControlError } from './mobile-control';
import { withSettingsSurface } from './settings-audit';
import { GRANT_REQUEST_TTL_MS } from '../../shared/grant-requests';
import type { MobileGrantAnswer } from '../../shared/mobile-control';

const NOW = Date.parse('2026-11-09T09:00:00Z');
const places: GrantRequestPlaces = { projects: [{ id: 'proj', path: '/p' }], dispatcher: { projectId: '__dispatcher__', paths: ['/base/dispatcher', '/base/dispatcher-chat'] } };
const REMOVE_ARGS = { device_id: 'dev_1' };

/** An Ask-first call, as ask-first.ts records it for Manage devices (#3068). */
function callRequest(agentId = 'a1', projectPath = '/p', at = NOW - 60_000): string {
  const argumentsText = JSON.stringify(REMOVE_ARGS, null, 2);
  const detail = 'Remove Phone (phone, in this network)';
  const result = recordGrantRequest(callKey(agentId, 'remove_device', REMOVE_ARGS), {
    kind: 'call', agentId, agentName: 'Dispatcher', projectPath, actions: ['device.manage'], where: 'the app', toolName: 'remove_device',
    details: `${detail}\n\n${argumentsText}`, detail, argumentsText, reason: 'The phone is lost.',
  }, at);
  if (!result.ok) throw new Error('not recorded');
  return result.request.requestId;
}

/** A request_grant ask (#3021). */
function grantRequest(agentId = 'a1', at = NOW - 30_000): string {
  const result = recordGrantRequest(`grant\0${agentId}\0settings.app.write`, {
    kind: 'grant', agentId, agentName: 'Ada', projectPath: '/p', actions: ['settings.app.write'], where: 'the app', target: { kind: 'app' },
    reason: 'To set the cheap model for easy tasks.',
  }, at);
  if (!result.ok) throw new Error('not recorded');
  return result.request.requestId;
}

const command = (requestId: string, answer: MobileGrantAnswer) => ({ version: 1 as const, commandId: 'c', epoch: 'e', type: 'grant.answer' as const, requestId, answer });
const phone = (requestId: string, answer: MobileGrantAnswer, assertAuthorized = vi.fn()) =>
  withSettingsSurface('mobile', 'peer-1', () => runGrantCommand(command(requestId, answer), places, { assertAuthorized }));
const desktop = (requestId: string, allow: boolean) => withSettingsSurface('ui', undefined, () => answerGrantRequest(requestId, allow));

async function rejection(promise: Promise<unknown>): Promise<MobileControlError> {
  try { await promise; } catch (err) { if (err instanceof MobileControlError) return err; throw err; }
  throw new Error('expected a rejection');
}

/** Everything an answer does that anyone can see: saved permissions, the one-use approval, what the agent hears, the audit. */
function effects(agentId: string) {
  return {
    grants: mocks.setAgentGrant.mock.calls.map((c) => c.slice(1)),
    approved: consumeCallApproval(callKey(agentId, 'remove_device', REMOVE_ARGS)),
    told: mocks.deliver.mock.calls.map((c) => c[1]),
    audit: mocks.audit.map(({ kind, outcome }) => ({ kind, outcome })),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.setAgentGrant.mockImplementation(async () => ({ rows: [] }));
  mocks.audit.length = 0;
  _resetGrantRequestsForTesting();
});

describe('grantRequests in the snapshot (#3205)', () => {
  it('lists every waiting request a phone can place, oldest first, with what the desktop shows', () => {
    const call = callRequest();
    const grant = grantRequest();
    const dispatcher = callRequest('disp', '/base/dispatcher', NOW - 90_000);
    callRequest('elsewhere', '/not/registered');
    const rows = buildMobileGrantRequests(places);
    expect(rows.map((r) => r.requestId)).toEqual([dispatcher, call, grant]);
    expect(rows[0].projectId).toBe('__dispatcher__');
    expect(rows[1]).toEqual({
      requestId: call, kind: 'call', projectId: 'proj', agent: { agentId: 'a1', name: 'Dispatcher' },
      actions: ['device.manage'], actionLabels: ['Manage devices'], where: 'the app', toolName: 'remove_device', target: null,
      summary: 'Wants to run remove_device, which needs: Manage devices on the app.',
      detail: 'Remove Phone (phone, in this network)', arguments: '{\n  "device_id": "dev_1"\n}', reason: 'The phone is lost.',
      allowEffect: 'Allow runs this one call when it tries again. Its permissions stay as they are.',
      requestedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW - 60_000 + GRANT_REQUEST_TTL_MS).toISOString(),
      answers: ['allow_once', 'decline'],
    });
    expect(rows[2]).toMatchObject({
      kind: 'grant', target: { kind: 'app' }, toolName: null, detail: null, arguments: null, summary: 'Asks for Change app settings on the app.',
      answers: ['allow_lasting', 'decline'],
    });
  });

  it('leaves out a request that expired', () => {
    callRequest('a1', '/p', NOW - GRANT_REQUEST_TTL_MS - 1);
    expect(buildMobileGrantRequests(places)).toEqual([]);
  });
});

describe('the store says when a request opens and why it closes', () => {
  it('answered, expired and withdrawn', async () => {
    const changes: GrantRequestChange[] = [];
    onGrantRequestsChanged((c) => changes.push(c));
    const answered = callRequest();
    await phone(answered, 'decline');
    const expiring = grantRequest();
    vi.setSystemTime(NOW + GRANT_REQUEST_TTL_MS);
    expect(listGrantRequests()).toEqual([]);
    expect(changes).toEqual([
      { kind: 'added', request: expect.objectContaining({ requestId: answered }) },
      { kind: 'closed', requestIds: [answered], reason: 'answered' },
      { kind: 'added', request: expect.objectContaining({ requestId: expiring }) },
      { kind: 'closed', requestIds: [expiring], reason: 'expired' },
    ]);
  });
});

describe('grant.answer: the desktop\'s answer, from a phone', () => {
  it.each([
    ['allow_once', 'call', true],
    ['decline', 'call', false],
    ['allow_lasting', 'grant', true],
    ['decline', 'grant', false],
  ] as const)('%s on a %s request does what the desktop\'s answer does', async (answer, kind, allow) => {
    const record = () => (kind === 'call' ? callRequest() : grantRequest());
    expect(await desktop(record(), allow)).toEqual({ ok: true });
    const fromDesktop = effects('a1');
    vi.clearAllMocks();
    mocks.audit.length = 0;
    const id = record();
    expect(await phone(id, answer)).toEqual({ requestId: id, kind, answer });
    expect(effects('a1')).toEqual(fromDesktop);
    expect(listGrantRequests()).toEqual([]);
  });

  it('keeps a one-use approval apart from a lasting grant', async () => {
    await phone(callRequest(), 'allow_once');
    expect(mocks.setAgentGrant).not.toHaveBeenCalled();
    // One call, once.
    expect(consumeCallApproval(callKey('a1', 'remove_device', REMOVE_ARGS))).toBe(true);
    expect(consumeCallApproval(callKey('a1', 'remove_device', REMOVE_ARGS))).toBe(false);
    await phone(grantRequest(), 'allow_lasting');
    expect(mocks.setAgentGrant).toHaveBeenCalledWith('/p', 'a1', { action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow' });
  });

  it('refuses an Allow the request doesn\'t offer, and the request still waits', async () => {
    const call = callRequest();
    const grant = grantRequest();
    const lastingCall = await rejection(phone(call, 'allow_lasting'));
    expect(lastingCall).toMatchObject({ code: 'grant_answer_not_offered', statusCode: 409, outcome: 'rejected' });
    expect(lastingCall.detail).toBe('This request is for one call. Allow it once, or decline it.');
    expect((await rejection(phone(grant, 'allow_once'))).code).toBe('grant_answer_not_offered');
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([call, grant]);
    expect(mocks.setAgentGrant).not.toHaveBeenCalled();
    expect(consumeCallApproval(callKey('a1', 'remove_device', REMOVE_ARGS))).toBe(false);
  });

  it('audits each answer as the desktop does, with the surface mobile', async () => {
    await desktop(callRequest(), true);
    await phone(grantRequest(), 'allow_lasting');
    await phone(callRequest(), 'decline');
    expect(mocks.audit).toEqual([
      { agentId: 'a1', kind: 'call', outcome: 'allowed', surface: 'ui' },
      { agentId: 'a1', kind: 'grant', outcome: 'allowed', surface: 'mobile' },
      { agentId: 'a1', kind: 'call', outcome: 'declined', surface: 'mobile' },
    ]);
  });

  it('refuses an expired request', async () => {
    const id = callRequest();
    vi.setSystemTime(NOW + GRANT_REQUEST_TTL_MS);
    const err = await rejection(phone(id, 'allow_once'));
    expect(err).toMatchObject({ code: 'grant_request_not_found', statusCode: 404, outcome: 'rejected', detail: 'This request has expired or was already answered.' });
    expect(consumeCallApproval(callKey('a1', 'remove_device', REMOVE_ARGS))).toBe(false);
    // Recorded as expired, not as an answer (the record leaves the surface off an expiry).
    expect(mocks.audit.map((a) => a.outcome)).toEqual(['expired']);
  });

  it('refuses a request already answered, from the phone or the desktop', async () => {
    const first = grantRequest();
    await phone(first, 'allow_lasting');
    expect((await rejection(phone(first, 'decline'))).code).toBe('grant_request_not_found');
    const second = callRequest();
    await desktop(second, false);
    expect((await rejection(phone(second, 'allow_once'))).code).toBe('grant_request_not_found');
    expect(consumeCallApproval(callKey('a1', 'remove_device', REMOVE_ARGS))).toBe(false);
    expect(mocks.setAgentGrant).toHaveBeenCalledTimes(1);
  });

  it('answered from the phone and the desktop at once, resolves exactly once', async () => {
    for (const phoneFirst of [true, false]) {
      vi.clearAllMocks();
      mocks.audit.length = 0;
      const id = grantRequest();
      const answers = phoneFirst
        ? [phone(id, 'allow_lasting').then(() => 'ok', (e: MobileControlError) => e.code), desktop(id, false).then((r) => (r.ok ? 'ok' : 'gone'))]
        : [desktop(id, false).then((r) => (r.ok ? 'ok' : 'gone')), phone(id, 'allow_lasting').then(() => 'ok', (e: MobileControlError) => e.code)];
      const results = await Promise.all(answers);
      expect(results).toEqual(phoneFirst ? ['ok', 'gone'] : ['ok', 'grant_request_not_found']);
      expect(mocks.audit).toHaveLength(1);
      expect(mocks.deliver).toHaveBeenCalledTimes(1);
      expect(mocks.setAgentGrant).toHaveBeenCalledTimes(phoneFirst ? 1 : 0);
    }
  });

  it('two phones at once: one answer lands', async () => {
    const id = callRequest();
    const results = await Promise.allSettled([phone(id, 'allow_once'), phone(id, 'decline')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(mocks.audit).toEqual([{ agentId: 'a1', kind: 'call', outcome: 'allowed', surface: 'mobile' }]);
  });

  it('a lasting grant that fails to save is put back for another try', async () => {
    const id = grantRequest();
    mocks.setAgentGrant.mockRejectedValueOnce(new Error('The permissions file is locked.'));
    const err = await rejection(phone(id, 'allow_lasting'));
    expect(err).toMatchObject({ code: 'grant_answer_failed', statusCode: 409, outcome: 'rejected', detail: 'The permissions file is locked.' });
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([id]);
    expect(mocks.audit).toEqual([]);
    await phone(id, 'allow_lasting');
    expect(listGrantRequests()).toEqual([]);
  });

  it('answers nothing once the phone\'s authorization changed', async () => {
    const id = callRequest();
    const revoked = vi.fn(() => { throw new MobileControlError('authorization_revoked', 403); });
    expect((await rejection(phone(id, 'allow_once', revoked))).code).toBe('authorization_revoked');
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([id]);
    expect(consumeCallApproval(callKey('a1', 'remove_device', REMOVE_ARGS))).toBe(false);
  });

  it('won\'t answer a request the phone couldn\'t have been shown', async () => {
    const id = callRequest('elsewhere', '/not/registered');
    expect((await rejection(phone(id, 'decline'))).code).toBe('grant_request_not_found');
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([id]);
  });

  it('refuses a caller that isn\'t a paired controller, and a malformed answer, before anything runs', async () => {
    const service = new MobileCommandService();
    const id = callRequest();
    const run = vi.fn(async () => phone(id, 'allow_once'));
    const body = { version: 1, commandId: 'c1', epoch: service.epoch, type: 'grant.answer', requestId: id, answer: 'allow_once' };
    const anonymous = await service.execute(undefined, body, run);
    expect(anonymous).toMatchObject({ statusCode: 403, body: { status: 'rejected', error: { code: 'client_certificate_required' } } });
    for (const bad of [{ ...body, answer: 'allow' }, { ...body, answer: 'allow_always' }, { ...body, force: true }, { ...body, answer: undefined }]) {
      expect((await service.execute('peer-1', bad, run)).body.error?.code).toBe('invalid_command');
    }
    expect(run).not.toHaveBeenCalled();
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([id]);
    // A paired controller's command runs as the mobile surface.
    const accepted = await service.execute('peer-1', body, (cmd) => runGrantCommand(cmd as ReturnType<typeof command>, places, { assertAuthorized: () => {} }));
    expect(accepted).toMatchObject({ statusCode: 200, body: { status: 'completed', result: { requestId: id, kind: 'call', answer: 'allow_once' } } });
    expect(mocks.audit).toEqual([{ agentId: 'a1', kind: 'call', outcome: 'allowed', surface: 'mobile' }]);
  });
});
