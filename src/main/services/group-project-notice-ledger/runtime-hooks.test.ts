/** Actual landed P1 + real private journal, with synthetic native witnesses only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  runtimeProviderRequestIdBrand,
  type RuntimeAttemptHooks,
  type RuntimeHandoffReceipt,
  type RuntimeLoss,
} from '../../../shared/chat/runtime';
import {
  _resetRuntimeCoordinatorForTests,
  RuntimePreIntentRefusal,
  runtimeNoticePort as notice,
  runtimeOwnerPort as runtimeOwner,
  type RuntimeLiveLease,
} from '../agent-runtime/runtime-coordinator';
import { NoticeJournalOwner, type NoticeLiveHandoff } from './journal';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-agent', generation: 'synthetic-generation' };
type Journal = Awaited<ReturnType<typeof NoticeJournalOwner.openSparse>>;
const journals: Journal[] = []; const homes: string[] = [];
beforeEach(() => { _resetRuntimeCoordinatorForTests(); });
afterEach(async () => {
  _resetRuntimeCoordinatorForTests(); // Close issued synthetic tickets before ledger retirement.
  for (const journal of journals.splice(0)) await journal.close();
  await Promise.all(homes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function journalIntent() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-real-hooks-')); homes.push(directory);
  const journal = await NoticeJournalOwner.openSparse({ directory, recipient, installationId: '11111111-2222-3333-4444-555555555555' }); journals.push(journal);
  await journal.append({ kind: 'initialize', recipient, baseline: 0 });
  await journal.append({ kind: 'scan', through: 1, eligible: [{ seq: 1, postId: 'synthetic-1' }] });
  await journal.append({ kind: 'intent', attemptId: 'synthetic-attempt', posts: [{ seq: 1, postId: 'synthetic-1' }], startedAt: 1 });
  return { journal, handle: await journal.captureLiveHandoff('synthetic-attempt') };
}
function live(): RuntimeLiveLease {
  const dormant = runtimeOwner.registerOwner('synthetic-agent', {});
  const started = runtimeOwner.claimStart(dormant); if (started.kind !== 'applied') throw new Error('Synthetic start refused');
  const attached = runtimeOwner.attachResource(started.start, { kind: 'chat', instance: {} });
  if (attached.kind !== 'applied') throw new Error('Synthetic witness refused');
  return attached.lease;
}
function journalHooks(journal: Journal, handle: NoticeLiveHandoff) {
  // This real assignment checks landed RuntimeAttemptHooks, not a copied shape.
  const hooks = {
    markEntered: vi.fn(() => journal.tryMarkHandoffEntered(handle)),
    onLoss: vi.fn((outcome: RuntimeLoss) => journal.claimLoss(handle, outcome)),
    onReceipt: vi.fn(async (receipt: RuntimeHandoffReceipt) => {
      if (receipt.kind === 'approved_handoff_ack') throw new Error('No approved journal mapper');
      const claim = journal.claimLoss(handle, 'unknown');
      if (claim.kind === 'claimed') await claim.committed;
    }),
  } satisfies RuntimeAttemptHooks;
  return hooks;
}
function dispatch(lease: RuntimeLiveLease, hooks: RuntimeAttemptHooks) {
  const scope = {}; const admission = notice.captureAdmission(scope);
  const handoff = notice.createHandoff(lease, admission, hooks); const publication = {};
  runtimeOwner.bindQueue(handoff, {}); runtimeOwner.bindPublication(handoff, publication);
  return { admission, handoff, publication };
}

describe('unwired real P1 and journal contract', () => {
  it('revokes the original issued ticket and persists one actual UNKNOWN loss', async () => {
    const { journal, handle } = await journalIntent(); const hooks = journalHooks(journal, handle); const lease = live();
    const { handoff, admission } = dispatch(lease, hooks); const ticket = notice.transportAdmission(handoff, lease.resource);
    expect(ticket.allowed()).toBe(false); expect(handoff.tryEnter()).toEqual({ kind: 'entered' }); expect(ticket.allowed()).toBe(true);
    notice.revokeScope(admission); expect(ticket.allowed()).toBe(false);
    expect(await notice.lossSettlement(handoff)).toEqual({ committedOutcome: 'uncertain' });
    expect(hooks.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
    notice.retireHandoff(handoff); expect(hooks.onLoss).toHaveBeenCalledTimes(1);
    expect(journal.snapshot()!.acceptedCount).toBe(0); expect(journal.retention.activeAnchors).toBe(0);
  });

  it('reconciles persisted intent itself when actual createHandoff refuses before any hook exists', async () => {
    const { journal, handle } = await journalIntent(); const hooks = journalHooks(journal, handle); const lease = live();
    const admission = notice.captureAdmission({}); notice.revokeScope(admission); const revision = journal.committedRevision;
    expect(() => notice.createHandoff(lease, admission, hooks)).toThrow(RuntimePreIntentRefusal);
    expect(hooks.markEntered).not.toHaveBeenCalled(); expect(hooks.onLoss).not.toHaveBeenCalled();
    const claim = journal.claimLoss(handle, 'unsubmitted'); if (claim.kind !== 'claimed') throw new Error('Expected original attempt claim');
    expect(await claim.committed).toEqual({ committedOutcome: 'unsubmitted' });
    expect(journal.committedRevision).toBe(revision + 1); expect(journal.snapshot()!.roots.ready?.count).toBe(1);
  });

  it('never reads the constructor error name as whole-attempt nonentry after an earlier entry', async () => {
    const { journal, handle } = await journalIntent(); const hooks = journalHooks(journal, handle); const lease = live();
    const first = dispatch(lease, hooks); expect(first.handoff.tryEnter()).toEqual({ kind: 'entered' });
    const secondHooks = journalHooks(journal, handle); const refusedAdmission = notice.captureAdmission({}); notice.revokeScope(refusedAdmission);
    expect(() => notice.createHandoff(lease, refusedAdmission, secondHooks)).toThrow(RuntimePreIntentRefusal);
    expect(secondHooks.markEntered).not.toHaveBeenCalled(); expect(secondHooks.onLoss).not.toHaveBeenCalled();
    const claim = journal.claimLoss(handle, 'unsubmitted'); if (claim.kind !== 'claimed') throw new Error('Expected original attempt claim');
    notice.revokeScope(first.admission); // Already owned journal producer, no second append.
    expect(notice.lossSettlement(first.handoff)).toBeUndefined();
    expect(await claim.committed).toEqual({ committedOutcome: 'uncertain' });
    expect(journal.snapshot()!.roots.ready).toBeUndefined(); expect(journal.snapshot()!.acceptedCount).toBe(0);
  });

  it('keeps unverified receipts UNKNOWN and actual P1 rejects a forged approved-ACK shape', async () => {
    const { journal, handle } = await journalIntent(); const hooks = journalHooks(journal, handle); const lease = live();
    const { handoff, publication } = dispatch(lease, hooks); expect(handoff.tryEnter()).toEqual({ kind: 'entered' });
    await handoff.observe({ kind: 'local_handoff', dispatchId: handoff.dispatchId, resource: lease.resource, boundary: 'sdk_input_consumed' });
    expect(journal.snapshot()!.acceptedCount).toBe(0); expect(journal.snapshot()!.roots.attempts?.count).toBe(1);
    await expect(handoff.observe({ kind: 'approved_handoff_ack', dispatchId: handoff.dispatchId, resource: lease.resource,
      request: { [runtimeProviderRequestIdBrand]: true }, provenance: 'codex_rpc' })).rejects.toThrow('ack_mapper_not_approved');
    expect(hooks.onReceipt).toHaveBeenCalledTimes(1);
    const transition = runtimeOwner.beginTransition(lease, 'reset'); expect(transition.kind).toBe('applied');
    expect(runtimeOwner.mayPublish(handoff, publication)).toBe(false);
    expect(notice.lossSettlement(handoff)).toBeUndefined();
    expect(journal.snapshot()!.acceptedCount).toBe(0);
  });
});
