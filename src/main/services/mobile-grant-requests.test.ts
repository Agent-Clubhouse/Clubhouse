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

import { buildMobileGrantRequests, grantOpenedPayload, grantRowVisibleTo, runGrantCommand, type GrantRequestPlaces } from './mobile-grant-requests';
import { answerGrantRequest } from './grant-request-answers';
import {
  _resetGrantRequestsForTesting, callKey, consumeCallApproval, dropGrantRequestsFor, listGrantRequests, onGrantRequestsChanged, recordGrantRequest,
  type GrantRequestChange,
} from './grant-requests';
import { MobileCommandService, MobileControlError } from './mobile-control';
import { withSettingsSurface } from './settings-audit';
import { GRANT_REQUEST_TTL_MS } from '../../shared/grant-requests';
import type { MobileGrantAnswer } from '../../shared/mobile-control';

const NOW = Date.parse('2026-11-09T09:00:00Z');
/** The Dispatcher on: its coordinator (`disp`) asks, and its requests show on the chat agent you talk to (`disp_chat`, #3036). */
const DISPATCHER = { projectId: '__dispatcher__', paths: ['/base/dispatcher', '/base/dispatcher-chat'], agentId: 'disp_chat', askingIds: ['disp', 'disp_chat'] };
const places: GrantRequestPlaces = { projects: [{ id: 'proj', path: '/p' }], dispatcher: DISPATCHER };
/** remove_device's real argument: the device's id, its fingerprint (#3068). */
const PHONE_ID = 'ab:cd:ef:01';
const REMOVE_ARGS = { id: PHONE_ID };
/** What remove_device's describer says for it, in full. */
const REMOVE_LINE = 'Remove Phone (phone, in this network). A device in the network goes from every device in it, and comes back only when a person pairs it again.';

/** An Ask-first call, as ask-first.ts records it for Manage devices (#3068). */
function callRequest(agentId = 'a1', projectPath = '/p', at = NOW - 60_000, args: Record<string, unknown> = REMOVE_ARGS): string {
  const argumentsText = JSON.stringify(args, null, 2);
  const detail = REMOVE_LINE;
  const result = recordGrantRequest(callKey(agentId, 'remove_device', args), {
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
const phone = (requestId: string, answer: MobileGrantAnswer, assertAuthorized = vi.fn(), viewer = 'peer-1', where = places) =>
  withSettingsSurface('mobile', viewer, () => runGrantCommand(command(requestId, answer), where, { assertAuthorized, viewer }));
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
    // The Dispatcher's coordinator asks; the request shows on the agent you talk to, as in the desktop sidebar.
    expect(rows[0]).toMatchObject({ projectId: '__dispatcher__', agent: { agentId: 'disp_chat', name: 'Dispatcher' } });
    expect(rows[1]).toEqual({
      requestId: call, kind: 'call', projectId: 'proj', agent: { agentId: 'a1', name: 'Dispatcher' },
      actions: ['device.manage'], actionLabels: ['Manage devices'], where: 'the app', toolName: 'remove_device', target: null,
      summary: 'Wants to run remove_device, which needs: Manage devices on the app.',
      detail: REMOVE_LINE, arguments: `{\n  "id": "${PHONE_ID}"\n}`, reason: 'The phone is lost.',
      allowEffect: 'Allow runs this one call when it tries again. Its permissions stay as they are.',
      requestedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW - 60_000 + GRANT_REQUEST_TTL_MS).toISOString(),
      answers: ['allow_once', 'decline'],
    });
    expect(rows[2]).toMatchObject({
      kind: 'grant', target: { kind: 'app' }, toolName: null, detail: null, arguments: null, summary: 'Asks for Change app settings on the app.',
      answers: ['allow_lasting', 'decline'],
    });
  });

  it('shows the Dispatcher\'s requests only while desktop Needs you does: on, or still running', () => {
    callRequest('disp', '/base/dispatcher');
    callRequest('disp_chat', '/base/dispatcher-chat', NOW - 30_000);
    expect(buildMobileGrantRequests(places).map((r) => r.agent.agentId)).toEqual(['disp_chat', 'disp_chat']);
    expect(buildMobileGrantRequests({ ...places, dispatcher: null })).toEqual([]);
  });

  it('leaves out, for the device itself, a Manage devices call that names it', () => {
    const [row] = (callRequest(), buildMobileGrantRequests(places));
    expect(grantRowVisibleTo(row, PHONE_ID)).toBe(false);
    // Ids compare as fingerprints do, in any case.
    expect(grantRowVisibleTo(row, PHONE_ID.toUpperCase())).toBe(false);
    expect(grantRowVisibleTo(row, 'other:device')).toBe(true);
    // A request that names no device, or one that isn't Manage devices, shows to everyone.
    const [ask] = (_resetGrantRequestsForTesting(), grantRequest(), buildMobileGrantRequests(places));
    expect(grantRowVisibleTo(ask, PHONE_ID)).toBe(true);
    expect(grantRowVisibleTo({ ...row, actions: ['settings.app.write'] }, PHONE_ID)).toBe(true);
  });

  it('opened events carry who asked and the id, never the arguments', () => {
    callRequest('disp', '/base/dispatcher');
    const [row] = buildMobileGrantRequests(places);
    expect(grantOpenedPayload(row)).toEqual({ agentId: 'disp_chat', requestId: row.requestId, kind: 'call', projectId: '__dispatcher__' });
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

  it('a device can\'t answer a Manage devices call that names it; another device and the desktop can', async () => {
    const id = callRequest();
    const self = await rejection(phone(id, 'decline', vi.fn(), PHONE_ID));
    expect(self).toMatchObject({ code: 'grant_request_not_found', statusCode: 404 });
    expect((await rejection(phone(id, 'allow_once', vi.fn(), PHONE_ID.toUpperCase()))).code).toBe('grant_request_not_found');
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([id]);
    expect(await phone(id, 'allow_once', vi.fn(), 'other:device')).toMatchObject({ requestId: id });
    const again = callRequest();
    expect(await desktop(again, false)).toEqual({ ok: true });
  });

  it('can\'t answer the Dispatcher\'s requests while desktop Needs you doesn\'t show them', async () => {
    const id = callRequest('disp', '/base/dispatcher');
    expect((await rejection(phone(id, 'decline', vi.fn(), 'peer-1', { ...places, dispatcher: null }))).code).toBe('grant_request_not_found');
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([id]);
    await phone(id, 'decline');
    expect(listGrantRequests()).toEqual([]);
  });

  it('a failed lasting save isn\'t put back once its agent was deleted meanwhile', async () => {
    const id = grantRequest();
    mocks.setAgentGrant.mockImplementationOnce(async () => { dropGrantRequestsFor('a1'); throw new Error('The agent is gone.'); });
    expect((await rejection(phone(id, 'allow_lasting'))).code).toBe('grant_request_not_found');
    expect(listGrantRequests()).toEqual([]);
  });

  it('a failed lasting save isn\'t put back when the agent asked the same again meanwhile', async () => {
    const id = grantRequest();
    let again = '';
    mocks.setAgentGrant.mockImplementationOnce(async () => { again = grantRequest(); throw new Error('The permissions file is locked.'); });
    expect((await rejection(phone(id, 'allow_lasting'))).code).toBe('grant_request_not_found');
    // The newer one waits, once.
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([again]);
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
    // A paired controller's command runs as its device's surface: mobile for a phone.
    const run2 = (cmd: unknown) => runGrantCommand(cmd as ReturnType<typeof command>, places, { assertAuthorized: () => {}, viewer: 'peer-1' });
    const accepted = await service.execute('peer-1', body, run2);
    expect(accepted).toMatchObject({ statusCode: 200, body: { status: 'completed', result: { requestId: id, kind: 'call', answer: 'allow_once' } } });
    // A computer controlling this one is audited as one.
    const fromDesktop = callRequest('a2');
    await service.execute('desk-1', { ...body, commandId: 'c2', requestId: fromDesktop, answer: 'decline' }, run2, 'annex_desktop');
    expect(mocks.audit).toEqual([
      { agentId: 'a1', kind: 'call', outcome: 'allowed', surface: 'mobile' },
      { agentId: 'a2', kind: 'call', outcome: 'declined', surface: 'annex_desktop' },
    ]);
  });
});

it.each(['mobile', 'annex_desktop'] as const)('rejects deletion batch answers from %s even with controller authorization', async (surface) => {
  const recorded = recordGrantRequest(callKey('a1', 'delete_agents', {}), {
    kind: 'call', agentId: 'a1', agentName: 'Ada', projectPath: '/p', actions: ['agent.dispose'], where: 'batch', deleteReview: { items: [] },
  }, NOW, { context: 'exact', asks: [] });
  if (!recorded.ok) throw new Error('not recorded');
  await expect(withSettingsSurface(surface, 'peer', () => runGrantCommand(command(recorded.request.requestId, 'allow_once'), places, { viewer: 'peer', assertAuthorized: () => {} })))
    .rejects.toMatchObject({ code: 'grant_answer_not_offered' });
  expect(listGrantRequests()).toHaveLength(1);
  expect(consumeCallApproval(callKey('a1', 'delete_agents', {}))).toBe(false);
});
