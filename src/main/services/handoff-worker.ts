import * as fs from 'fs';
import * as path from 'path';
import { isTerminalHandoff, type Handoff, type HandoffFailure, type HandoffResult } from '../../shared/handoffs';
import type { HandoffTransferBounds } from '../../shared/handoff-manifest';
import type { HandoffTransferRequest } from '../../shared/handoff-transfer';
import type { HandoffSecretPolicy } from './handoff-secret-settings';
import type { HandoffService } from './handoff-service';
import { receiveHandoffSnapshot, HandoffTransferInterrupted } from './handoff-transfer-receiver';
import { receiveHandoffCommit } from './handoff-git-receive';
import { applyHandoffSnapshot } from './handoff-apply';
import { HandoffSnapshotError, readHandoffSnapshotManifest, verifyHandoffSnapshot } from './handoff-snapshot';
export class HandoffAuthorizationChanged extends Error {
  constructor() { super('Handoff receiver permissions or connection changed. Selected agents must allow handoff acceptance; Dispatchers must allow waking and messaging them.'); }
}
export class HandoffProjectUnavailable extends Error {
  constructor() { super('No matching registered project for this handoff. Choose a matching project before accepting a new offer.'); }
}
type Advance = Parameters<HandoffService['advance']>[1];
export interface HandoffWorkerOptions {
  machine: string;
  records(): Handoff[];
  advance(record: Handoff, update: Advance): Promise<Handoff>;
  sync(id: string): Promise<void>;
  authorize(record: Handoff): Promise<void>;
  resolve(record: Handoff): Promise<{ projectId: string; projectRoot: string; bounds: HandoffTransferBounds; secretPolicy?: HandoffSecretPolicy; linkedProject?: boolean }>;
  stagingRoot(): Promise<string>;
  request(record: Handoff, request: HandoffTransferRequest): Promise<unknown>;
  wake(record: Handoff, result: HandoffResult, admission: () => boolean): Promise<void>;
  timeoutMs?: number;
  receive?: typeof receiveHandoffSnapshot;
  acquire?: typeof receiveHandoffCommit;
  apply?: typeof applyHandoffSnapshot;
}
interface Attempt { active: boolean; step: HandoffFailure['step'] }

/** Receiver-owned continuation. Acceptance is the last user gate; every side effect rechecks it. */
export class HandoffWorker {
  private readonly active = new Map<string, Attempt>();
  constructor(private readonly options: HandoffWorkerOptions) {}
  private record(id: string): Handoff {
    const record = this.options.records().find((value) => value.id === id);
    if (!record || record.to.machine !== this.options.machine || !record.acceptance || isTerminalHandoff(record.state)) throw new Error('Handoff is no longer active.');
    return record;
  }
  private async cleanup(id: string): Promise<void> {
    const parent = await this.options.stagingRoot();
    const stat = await fs.promises.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !path.isAbsolute(parent) || path.relative(parent, await fs.promises.realpath(parent)) !== '') throw new HandoffSnapshotError('invalid_staging');
    await fs.promises.rm(path.join(parent, id), { recursive: true, force: true });
  }
  private async fail(id: string, attempt: Attempt, error: unknown): Promise<void> {
    const record = this.options.records().find((value) => value.id === id);
    if (!record || isTerminalHandoff(record.state)) return;
    const verification = error instanceof HandoffSnapshotError && ['secret_blocked', 'hash_mismatch', 'unsafe_entry'].includes(error.code);
    const step = error instanceof HandoffAuthorizationChanged ? 'authorization' : error instanceof HandoffProjectUnavailable ? 'apply' : verification ? 'verification' : attempt.step;
    const code = step === 'authorization' ? 'authorization_changed' : step === 'verification' ? 'verification_failed' : step === 'apply' ? 'apply_failed' : step === 'wake' ? 'wake_failed' : 'transfer_failed';
    await this.options.advance(record, { state: 'failed', failure: { step, code },
      ...(error instanceof HandoffAuthorizationChanged || error instanceof HandoffProjectUnavailable || error instanceof HandoffSnapshotError ? { reason: error.message.slice(0, 512) } : {}) });
  }
  async run(id: string): Promise<void> {
    if (this.active.has(id) || this.active.size >= 2) return;
    const original = this.options.records().find((value) => value.id === id);
    if (!original || original.to.machine !== this.options.machine || !original.acceptance || !['accepted', 'transferring', 'verifying'].includes(original.state)) return;
    const attempt: Attempt = { active: true, step: 'verification' }; this.active.set(id, attempt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        attempt.active = false;
        void this.fail(id, attempt, new Error('Handoff deadline exceeded.')).catch(() => {}); // telemetry-exempt: durable storage reports failures at its own boundary
        resolve();
      }, this.options.timeoutMs ?? 10 * 60_000);
    });
    const authorize = async () => {
      if (!attempt.active || this.active.get(id) !== attempt) throw new Error('Handoff attempt expired.');
      await this.options.authorize(this.record(id));
      if (!attempt.active || this.active.get(id) !== attempt) throw new Error('Handoff attempt expired.');
    };
    const work = (async () => {
      let interrupted = false;
      try {
        await authorize();
        const receiver = await this.options.resolve(this.record(id));
        await authorize();
        const parent = await this.options.stagingRoot();
        let record = this.record(id);
        if (!record.manifest) throw new Error('Handoff needs a prepared manifest.');
        const policy = receiver.secretPolicy;
        let snapshot;
        if (record.state === 'verifying') {
          const root = path.join(parent, id);
          const manifest = await readHandoffSnapshotManifest(root, record.manifest, receiver.bounds);
          snapshot = await verifyHandoffSnapshot(root, manifest, record.manifest, receiver.bounds, policy ? { policy, handoffId: id } : undefined);
        } else {
          attempt.step = 'transfer';
          if (record.state === 'accepted') record = await this.options.advance(record, { state: 'transferring', bytesDone: 0 });
          try { await this.options.sync(id); } catch { throw new HandoffTransferInterrupted(); /* telemetry-exempt: disconnected synchronization resumes on the next sweep */ }
          await authorize();
          let reported = record.progress?.bytesDone ?? 0;
          snapshot = await (this.options.receive ?? receiveHandoffSnapshot)({
            id, stagingRoot: parent, expected: record.manifest!, bounds: receiver.bounds, secretPolicy: policy, authorize,
            request: (request) => this.options.request(this.record(id), request),
            progress: async (done, total) => {
              if (done <= reported || done < total && done - reported < Math.max(1, Math.ceil(total / 100))) return;
              await authorize(); await this.options.advance(this.record(id), { state: 'transferring', bytesDone: done }); reported = done;
            },
          });
          await authorize(); record = await this.options.advance(this.record(id), { state: 'verifying' });
        }
        attempt.step = 'verification';
        await authorize();
        await (this.options.acquire ?? receiveHandoffCommit)({ projectRoot: receiver.projectRoot, snapshot, bounds: receiver.bounds, handoffId: id, secretPolicy: policy, linkedProject: receiver.linkedProject, authorize });
        attempt.step = 'apply';
        const applied = await (this.options.apply ?? applyHandoffSnapshot)({
          id, projectId: receiver.projectId, projectRoot: receiver.projectRoot, snapshot, bounds: receiver.bounds, secretPolicy: policy, authorize,
          checkpoint: async (checkpoint) => { await authorize(); await this.options.advance(this.record(id), { state: 'applying', checkpoint }); },
        });
        await authorize(); attempt.step = 'wake'; record = this.record(id);
        const result: HandoffResult = { agent: record.acceptance!.target, ...applied };
        await this.options.wake(record, result, () => attempt.active && this.active.get(id) === attempt
          && !!this.options.records().find((current) => current.id === id && current.state === 'applying' && current.version === record.version));
        await authorize(); await this.options.advance(this.record(id), { state: 'applied', result });
      } catch (error) {
        // telemetry-exempt: the durable failed state is the user-facing report; transport interruption retains resumable data
        interrupted = error instanceof HandoffTransferInterrupted;
        if (!interrupted && attempt.active) await this.fail(id, attempt, error);
      } finally {
        if (!interrupted && attempt.active) await this.cleanup(id);
      }
    })();
    try { await Promise.race([work, expired]); }
    catch { /* telemetry-exempt: background continuation never exposes private diagnostics; retained state is inspected through get_handoff */ }
    finally {
      if (timer) clearTimeout(timer); attempt.active = false;
      if (this.active.get(id) === attempt) this.active.delete(id);
      // Consume a late filesystem/descriptor failure after the total deadline.
      void work.catch(() => {}); // telemetry-exempt: the expired attempt cannot advance, apply further files, or wake an agent
    }
  }
  async flush(): Promise<void> {
    for (const record of this.options.records()) {
      if (record.to.machine !== this.options.machine) continue;
      if (isTerminalHandoff(record.state)) {
        const running = this.active.get(record.id); if (running) running.active = false;
        await this.cleanup(record.id);
      } else void this.run(record.id);
    }
  }
  stop(): void { for (const attempt of this.active.values()) attempt.active = false; this.active.clear(); }
}
