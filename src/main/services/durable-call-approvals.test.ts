import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-call-approvals-'));

import {
  createDurableCallApprovals, DURABLE_APPROVAL_MAX_RECORDS, DURABLE_APPROVAL_MAX_BYTES,
  type AnsweredOriginalCall, type DurableCallIdentity,
} from './durable-call-approvals';
import { deliveryHash, DELIVERY_MAX_AGE_MS, DELIVERY_RETENTION_MS } from './annex-delivery-store';
import { GRANT_REQUEST_TTL_MS } from '../../shared/grant-requests';

const now = Date.UTC(2026, 10, 12, 12);
const machine = Array(16).fill('aa').join(':');
const identity: DurableCallIdentity = {
  callerId: 'caller', callKey: 'canonical-call-key', toolName: 'hand_off_request',
  protocol: 'federation', operation: 'hand_off_request', machineId: machine, targetId: 'receiver-controller',
  epoch: { sender: 'sender-pairing-epoch', receiver: 'receiver-pairing-epoch' },
  displayTarget: 'Dispatcher on Mac', policyContext: deliveryHash({ grant: 'ask', policy: 'original' }),
};
const asks = [{ action: 'agent.message' as const, where: 'Dispatcher on Mac' }];
const payload = {
  v: 1, callId: 'delivery-one', from: { agentId: 'caller', name: 'Caller', projectName: 'Project' },
  to: identity.targetId, tool: identity.operation, protocol: identity.protocol, commandId: 'command-one', epoch: identity.epoch,
  args: { request: 'Private request text', origin: { requestId: 'original-request' } }, context: { rootId: 'original-request', depth: 0 },
};
let sequence = 0;
const fixture = () => {
  const filename = `ledger-${++sequence}.json`;
  const answers = new Map<string, AnsweredOriginalCall>();
  const ledger = createDurableCallApprovals((id) => answers.get(id), filename);
  const intent = ledger.prepare(identity, deliveryHash(payload), asks, 'command-one', now);
  const answer = (requestId = 'clicked-request'): AnsweredOriginalCall => ({
    requestId, callerId: identity.callerId, callKey: identity.callKey,
    scope: structuredClone(intent.scope), expiresAt: now + GRANT_REQUEST_TTL_MS,
  });
  const click = async (requestId = 'clicked-request') => {
    answers.set(requestId, answer(requestId));
    try { return await ledger.approveAnsweredRequest(requestId, now); }
    finally { answers.delete(requestId); }
  };
  const restart = () => createDurableCallApprovals(() => undefined, filename);
  return { filename, file: path.join(state.base, filename), ledger, intent, answers, answer, click, restart };
};

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => fs.rmSync(state.base, { recursive: true, force: true }));

describe('durable original-click approval ledger (not activated)', () => {
  it('cannot mint from a request id, Allow flag, prepared context, or preview without an actual original answer', async () => {
    const f = fixture();
    await expect(f.ledger.approveAnsweredRequest('clicked-request', now)).rejects.toMatchObject({ code: 'approval_not_original' });
    expect(await f.ledger.claim({ requestId: 'clicked-request' }, f.intent, 'allow', now)).toEqual({ allowed: false, reason: 'approval_missing_or_invalid' });
    expect(f.ledger.verify({ requestId: 'clicked-request', approved: true }, f.intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_missing_or_invalid' });
    expect(fs.existsSync(f.file)).toBe(false);
  });

  it('does not create a receipt file for ordinary permission edits without caller proof or preparation', async () => {
    const f = fixture();
    await f.ledger.revokeCaller('unrelated-caller', now);
    expect(fs.existsSync(f.file)).toBe(false);
  });

  it('requires the original pre-click snapshot and never reconstructs one after restart or retarget', async () => {
    const f = fixture();
    f.answers.set('clicked-request', f.answer());
    const restarted = createDurableCallApprovals((id) => f.answers.get(id), f.filename);
    await expect(restarted.approveAnsweredRequest('clicked-request', now)).rejects.toMatchObject({ code: 'approval_not_original' });
    f.answers.set('clicked-request', { ...f.answer(), callerId: 'another-caller' });
    await expect(f.ledger.approveAnsweredRequest('clicked-request', now)).rejects.toMatchObject({ code: 'approval_not_original' });
    f.answers.set('clicked-request', { ...f.answer(), callKey: 'another-call' });
    await expect(f.ledger.approveAnsweredRequest('clicked-request', now)).rejects.toMatchObject({ code: 'approval_not_original' });
  });

  it('persists exact approval before success, claims before use, and survives restart without storing payload text', async () => {
    const f = fixture();
    const reference = await f.click();
    expect(f.ledger.verify(reference, f.intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_not_bound' });
    expect(f.restart().findUnclaimedForCall(identity.callKey, now)?.reference).toEqual(reference);
    expect(await f.restart().claim(reference, f.intent, 'ask', now)).toEqual({ allowed: true });
    expect(f.restart().verify(reference, f.intent, 'ask', now + 1)).toEqual({ allowed: true });
    expect(f.restart().findUnclaimedForCall(identity.callKey, now + 1)).toBeUndefined();
    const raw = fs.readFileSync(f.file, 'utf8');
    expect(raw).not.toContain(payload.args.request);
    expect(JSON.parse(raw).receipts[0].intent.wirePayloadHash).toBe(deliveryHash(payload));
    if (process.platform !== 'win32') expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  });

  it('rechecks the real claim deadline after waiting behind a pending ledger write', async () => {
    const f = fixture();
    const reference = await f.click();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + GRANT_REQUEST_TTL_MS - 100);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { entered(); await gate; return rename(from, to); });
    f.answers.set('another-click', f.answer('another-click'));
    const writing = f.ledger.approveAnsweredRequest('another-click');
    await started;
    const claiming = f.ledger.claim(reference, f.intent, 'ask');
    vi.setSystemTime(now + GRANT_REQUEST_TTL_MS);
    release();
    await writing;
    expect(await claiming).toEqual({ allowed: false, reason: 'approval_expired' });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).receipts.every((receipt: { boundAt?: number }) => receipt.boundAt === undefined)).toBe(true);
  });

  it('does not widen the original approved asks when policy changes while the human request is pending', async () => {
    const f = fixture();
    const expanded = f.ledger.prepare({
      ...identity, policyContext: deliveryHash({ grant: 'ask', policy: 'new-read-requirement' }),
    }, deliveryHash(payload), [...asks, { action: 'agent.read', where: 'Dispatcher on Mac' }], 'command-one', now);
    const reference = await f.click();
    expect(await f.ledger.claim(reference, expanded, 'ask', now)).toEqual({ allowed: false, reason: 'approval_changed' });
    expect(await f.ledger.claim(reference, f.intent, 'refuse', now)).toEqual({ allowed: false, reason: 'grant_refused' });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).receipts[0].intent.scope.asks).toEqual(asks);
  });

  it.each([
    ['caller', { callerId: 'other' }],
    ['call key', { callKey: 'another-call' }],
    ['tool', { toolName: 'send_remote_dispatcher_message' }],
    ['protocol', { protocol: 'handoff' as const }],
    ['operation', { operation: 'send_message' }],
    ['canonical machine', { machineId: Array(16).fill('bb').join(':') }],
    ['canonical target', { targetId: 'replacement-controller' }],
    ['alias/presentation', { displayTarget: 'Dispatcher on another Mac' }],
    ['sender pairing', { epoch: { ...identity.epoch, sender: 'replacement-pairing' } }],
    ['receiver pairing', { epoch: { ...identity.epoch, receiver: 'replacement-pairing' } }],
    ['policy', { policyContext: deliveryHash('changed-policy') }],
  ])('refuses %s changes instead of treating a reference as reusable authority', async (_label, change) => {
    const f = fixture();
    const reference = await f.click();
    const changed = f.ledger.prepare({ ...identity, ...change }, deliveryHash(payload), asks, 'command-one', now);
    expect(await f.ledger.claim(reference, changed, 'ask', now)).toEqual({ allowed: false, reason: 'approval_changed' });
  });

  it('binds the actual payload, inherited cause and command id, not a displayed preview or same text', async () => {
    const f = fixture();
    const reference = await f.click();
    for (const changed of [
      f.ledger.prepare(identity, deliveryHash({ ...payload, args: { ...payload.args, request: 'Changed actual payload' } }), asks, 'command-one', now),
      f.ledger.prepare(identity, deliveryHash({ ...payload, context: { ...payload.context, depth: 1 } }), asks, 'command-one', now),
      f.ledger.prepare(identity, deliveryHash({ ...payload, from: { ...payload.from, name: 'Changed derived sender name' } }), asks, 'command-one', now),
      f.ledger.prepare(identity, deliveryHash({ ...payload, from: { ...payload.from, projectName: 'Changed derived project' } }), asks, 'command-one', now),
      f.ledger.prepare(identity, deliveryHash(payload), asks, 'command-two', now),
    ]) expect(await f.ledger.claim(reference, changed, 'ask', now)).toEqual({ allowed: false, reason: 'approval_changed' });
    const tampered = { ...f.intent, scope: { ...f.intent.scope, asks: [...asks, { action: 'agent.read' as const, where: 'Mac' }] } };
    expect(await f.ledger.claim(reference, tampered, 'ask', now)).toEqual({ allowed: false, reason: 'approval_missing_or_invalid' });
  });

  it('allows only the same bound command on retries, never extends its lifetime, and makes fresh Off win', async () => {
    const f = fixture();
    const reference = await f.click();
    expect(await f.ledger.claim(reference, f.intent, 'ask', now + 1)).toEqual({ allowed: true });
    expect(await f.ledger.claim(reference, f.intent, 'ask', now + 2)).toEqual({ allowed: true });
    expect(f.ledger.verify(reference, f.intent, 'refuse', now + 2)).toEqual({ allowed: false, reason: 'grant_refused' });
    expect(f.ledger.verify(reference, f.intent, 'ask', now + 1 + DELIVERY_MAX_AGE_MS)).toEqual({ allowed: false, reason: 'approval_expired' });
    expect(await f.ledger.claim(reference, f.intent, 'ask', now + 1 + DELIVERY_MAX_AGE_MS)).toEqual({ allowed: false, reason: 'approval_expired' });
  });

  it('expires unclaimed approvals at the original request deadline', async () => {
    const f = fixture();
    const reference = await f.click();
    expect(await f.ledger.claim(reference, f.intent, 'ask', now + GRANT_REQUEST_TTL_MS)).toEqual({ allowed: false, reason: 'approval_expired' });
    f.answers.set('expired-click', { ...f.answer('expired-click'), expiresAt: now });
    await expect(f.ledger.approveAnsweredRequest('expired-click', now)).rejects.toMatchObject({ code: 'approval_expired' });
  });

  it('publishes neither receipt nor claim until the atomic rename succeeds', async () => {
    const f = fixture();
    const rename = fs.promises.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { await gate; return rename(from, to); });
    const approving = f.click();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(f.ledger.findUnclaimedForCall(identity.callKey, now)).toBeUndefined();
    expect(f.restart().findUnclaimedForCall(identity.callKey, now)).toBeUndefined();
    release();
    const reference = await approving;
    const claimGate = new Promise<void>((resolve) => { release = resolve; });
    spy.mockClear().mockImplementation(async (from, to) => { await claimGate; return rename(from, to); });
    const claiming = f.ledger.claim(reference, f.intent, 'ask', now);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(f.ledger.verify(reference, f.intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_not_bound' });
    expect(f.restart().verify(reference, f.intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_not_bound' });
    release();
    expect(await claiming).toEqual({ allowed: true });
  });

  it('a failed approval or claim write cannot leave usable in-memory proof', async () => {
    const f = fixture();
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk write blocked'));
    await expect(f.click()).rejects.toThrow('disk write blocked');
    expect(f.ledger.findUnclaimedForCall(identity.callKey, now)).toBeUndefined();
    const reference = await f.click();
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('claim write blocked'));
    await expect(f.ledger.claim(reference, f.intent, 'ask', now)).rejects.toThrow('claim write blocked');
    expect(f.ledger.verify(reference, f.intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_not_bound' });
    expect(f.restart().verify(reference, f.intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_not_bound' });
  });

  it('serializes competing claims and revocation without widening or losing records', async () => {
    const f = fixture();
    const reference = await f.click();
    const [first, second] = await Promise.all([
      f.ledger.claim(reference, f.intent, 'ask', now),
      f.ledger.claim(reference, f.intent, 'ask', now),
      f.ledger.revokeCaller(identity.callerId, now),
    ]);
    expect([first, second]).toEqual([
      { allowed: false, reason: 'approval_revoked' }, { allowed: false, reason: 'approval_revoked' },
    ]);
    expect(f.restart().verify(reference, f.intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_revoked' });
  });

  it('immediately revokes an in-flight approval even if its later revocation write fails', async () => {
    const f = fixture();
    const rename = fs.promises.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => { await gate; return rename(from, to); });
    const approving = f.click();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRejectedValueOnce(new Error('revocation write blocked'));
    const revoking = f.ledger.revokeCaller(identity.callerId, now);
    release();
    const reference = await approving;
    await expect(revoking).rejects.toThrow('revocation write blocked');
    expect(await f.ledger.claim(reference, f.intent, 'ask', now)).toEqual({ allowed: false, reason: 'approval_revoked' });
    expect(f.ledger.findUnclaimedForCall(identity.callKey, now)).toBeUndefined();
  });

  it.each(['{', '{}', '{"version":1}', '{"receipts":[]}', '{"version":2,"receipts":[]}', '{"version":1,"receipts":[{}]}'])('fails closed on corrupt or incomplete authority file %s', async (raw) => {
    const f = fixture();
    fs.writeFileSync(f.file, raw);
    expect(() => f.ledger.findUnclaimedForCall(identity.callKey, now)).toThrow('approval store is unreadable');
    await expect(f.click()).rejects.toMatchObject({ code: 'approval_store_unreadable' });
    expect(await f.ledger.claim({ requestId: 'clicked-request' }, f.intent, 'refuse', now)).toEqual({ allowed: false, reason: 'grant_refused' });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(raw);
  });

  it('rejects duplicate ids, altered context hashes and oversized files without overwriting them', async () => {
    const f = fixture();
    await f.click();
    const file = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    for (const bad of [
      { ...file, receipts: [file.receipts[0], file.receipts[0]] },
      { ...file, receipts: [{ ...file.receipts[0], intent: { ...file.receipts[0].intent, targetId: 'substituted' } }] },
      { ...file, padding: 'x'.repeat(DURABLE_APPROVAL_MAX_BYTES) },
    ]) {
      fs.writeFileSync(f.file, JSON.stringify(bad));
      expect(() => f.restart().findUnclaimedForCall(identity.callKey, now)).toThrow('approval store is unreadable');
    }
  });

  it('keeps every live receipt at the exact count bound and admits new work only after expiry', async () => {
    const f = fixture();
    await f.click();
    const file = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    file.receipts = Array.from({ length: DURABLE_APPROVAL_MAX_RECORDS }, (_, index) => ({ ...file.receipts[0], requestId: `existing-${index}` }));
    fs.writeFileSync(f.file, JSON.stringify(file));
    const full = createDurableCallApprovals((id) => f.answers.get(id), f.filename);
    const intent = full.prepare(identity, deliveryHash(payload), asks, 'command-new', now);
    f.answers.set('new-click', { ...f.answer('new-click'), scope: intent.scope });
    await expect(full.approveAnsweredRequest('new-click', now)).rejects.toMatchObject({ code: 'approval_store_full' });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).receipts).toHaveLength(DURABLE_APPROVAL_MAX_RECORDS);
    const later = now + DELIVERY_RETENTION_MS;
    const laterIntent = full.prepare(identity, deliveryHash(payload), asks, 'command-later', later);
    f.answers.set('later-click', { ...f.answer('later-click'), scope: laterIntent.scope, expiresAt: later + GRANT_REQUEST_TTL_MS });
    await full.approveAnsweredRequest('later-click', later);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).receipts.map((receipt: { requestId: string }) => receipt.requestId)).toEqual(['later-click']);
  });

  it('refuses writes exceeding the byte bound without evicting any unexpired proof', async () => {
    const f = fixture();
    await f.click();
    const wideAsks = Array.from({ length: 20 }, () => ({ action: 'agent.message' as const, where: 'x'.repeat(1_000) }));
    const wide = f.ledger.prepare(identity, deliveryHash(payload), wideAsks, 'wide-command', now);
    f.answers.set('wide-click', { ...f.answer('wide-click'), scope: wide.scope });
    await f.ledger.approveAnsweredRequest('wide-click', now);
    const file = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    const receipt = file.receipts[1];
    file.receipts = [];
    for (let index = 0; ; index++) {
      file.receipts.push({ ...receipt, requestId: `wide-${index}` });
      if (Buffer.byteLength(JSON.stringify(file)) > DURABLE_APPROVAL_MAX_BYTES) { file.receipts.pop(); break; }
    }
    const before = JSON.stringify(file);
    expect(file.receipts.length).toBeLessThan(DURABLE_APPROVAL_MAX_RECORDS);
    fs.writeFileSync(f.file, before);
    const full = createDurableCallApprovals((id) => f.answers.get(id), f.filename);
    const intent = full.prepare(identity, deliveryHash(payload), wideAsks, 'another-wide-command', now);
    f.answers.set('another-wide-click', { ...f.answer('another-wide-click'), scope: intent.scope });
    await expect(full.approveAnsweredRequest('another-wide-click', now)).rejects.toMatchObject({ code: 'approval_store_full' });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  });

  it('accepts a complete file at the exact byte bound but rejects one extra byte', () => {
    const f = fixture();
    const exact = '{"version":1,"receipts":[]}'.padEnd(DURABLE_APPROVAL_MAX_BYTES, ' ');
    fs.writeFileSync(f.file, exact);
    expect(f.restart().findUnclaimedForCall(identity.callKey, now)).toBeUndefined();
    fs.writeFileSync(f.file, `${exact} `);
    expect(() => f.restart().findUnclaimedForCall(identity.callKey, now)).toThrow('approval store is unreadable');
  });

  it('bounds unapproved preparations without evicting one and frees them at expiry', async () => {
    const f = fixture();
    for (let index = 1; index < 256; index++) f.ledger.prepare(identity, deliveryHash({ ...payload, commandId: `command-${index}` }), asks, `command-${index}`, now);
    expect(() => f.ledger.prepare(identity, deliveryHash(payload), asks, 'overflow', now)).toThrow('Too many calls');
    await expect(f.click()).resolves.toEqual({ requestId: 'clicked-request' });
    expect(() => f.ledger.prepare(identity, deliveryHash(payload), asks, 'after-expiry', now + GRANT_REQUEST_TTL_MS)).not.toThrow();
  });
});
