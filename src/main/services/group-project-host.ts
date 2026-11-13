/**
 * GroupProjectHost — the one authoritative writer for group projects (#3356).
 *
 * Every change to a group project's record, membership or board goes through
 * this service. Changes to one group project are serialized, each gets the next
 * sequence number for that group project, and the number is saved (in
 * `<id>/host.json`, before the change itself) so it keeps increasing across
 * restarts. Remote writes over Annex (#3363) arrive through the same methods.
 *
 * The registry, board and membership stores are private to this module: a
 * guard test fails any other module that writes them.
 */

import type {
  BulletinMessage, GroupProject, GroupProjectChange, GroupProjectChangePart, GroupProjectCreateOptions, GroupProjectHost,
  DigestSince, GroupProjectMemberView, GroupProjectMembership, GroupProjectNetworkRefusal, GroupProjectNetworkState,
  GroupProjectScope, GroupProjectScopeOptions, GroupProjectTombstone, TopicDigest,
} from '../../shared/group-project-types';
import {
  GroupProjectScopeError, memberInScope, membersLeavingScope, resolveGroupProjectScope, sameGroupProjectScope,
} from '../../shared/group-project-scope';
import { canonicalMemberAddress, memberAddress } from '../../shared/group-project-members';
import { parseAgentAddress } from '../../shared/agent-address';
import { groupProjectRegistry } from './group-project-registry';
import {
  PROJECT_CHANNELS, destroyBulletinBoard, ensureInboxChannel, ensureProjectChannels, flushAllBulletinBoards,
  getBulletinBoard, normalizeChannelName, resolveInboxChannel,
} from './group-project-bulletin';
import { emptyMembership, readMembershipFile, validateMembership, writeMembershipFile } from './group-project-membership-file';
import * as fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import {
  assertGroupProjectId, groupProjectDir, hostStatePath, networkAppliedPath, networkOutboxPath, networkRefusalsPath, replicaStatePath,
  replicaTombstonesPath, tombstonesPath,
} from './group-project-paths';
import { createHash, randomUUID } from 'crypto';
import {
  applyMembershipPatch, isEmptyPatch, membershipPatch,
  type MembershipPatch, type QueuedWrite, type ReplicaSnapshot, type SyncRequest, type SyncResponse, type WriteAuthor, type WriteOp, type WriteRequest, type WriteResponse, type WriteResult,
} from '../../shared/group-project-network';
import { readJsonFile, writeJsonFile } from './group-project-json-file';
import * as annexIdentity from './annex-identity';
import { networkEnabled } from './annex-settings';
import * as projectStore from './project-store';
import * as agentConfig from './agent-config';
import { agentRegistry } from './agent-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { annexEphemeralSession } from './annex-network-profile';
import { appLog } from './log-service';
import { publishAppEvent } from './app-event-bus';

export type GroupProjectHostErrorCode =
  | 'not_found' | 'changed' | 'invalid' | 'network_unavailable' | 'out_of_scope'
  /** #3363: only the host can do this; a copy whose host left; the host refused; too much waiting. */
  | 'not_host' | 'read_only' | 'refused' | 'queue_full';

export class GroupProjectHostError extends Error {
  constructor(readonly code: GroupProjectHostErrorCode, message: string) {
    super(message);
    this.name = 'GroupProjectHostError';
  }
}

/** Who is a member now; #3357 registers its policy, otherwise wires decide. */
export type GroupProjectMemberResolver = (project: GroupProject, membership: GroupProjectMembership) => Promise<GroupProjectMemberView[]>;

type ChangeListener = (change: GroupProjectChange) => void;

/** How the host service reaches other computers in the network (#3363); group-project-network.ts provides it. */
export interface GroupProjectNetworkLink {
  /** Connected to that computer now. */
  connected(machine: string): boolean;
  /** A computer in this machine's Annex Network. */
  isMember(machine: string): boolean;
  machineName(machine: string): string | undefined;
  sync(machine: string, request: SyncRequest): Promise<SyncResponse>;
  sendWrites(machine: string, writes: QueuedWrite[]): Promise<WriteResponse>;
  /** Tell the author of a refused write (an agent here), if there is one to tell. */
  notifyRefusal?(refusal: GroupProjectNetworkRefusal): void;
}

/** The grant a remote agent's write needs (#3360's actions). */
export type RemoteWriteAction = 'group_project.post' | 'group_project.lead' | 'group_project.admin';

const REMOTE_ACTION: Record<WriteOp['op'], RemoteWriteAction> = {
  post: 'group_project.post',
  ensureChannels: 'group_project.post',
  ensureInbox: 'group_project.post',
  deleteMessage: 'group_project.lead',
  deleteTopic: 'group_project.lead',
  setTopicProtected: 'group_project.lead',
  update: 'group_project.admin',
  membership: 'group_project.admin',
};

/** What a remote agent's write is checked against; answers a reason to refuse, or undefined to allow. */
export interface RemoteWriteCheck {
  project: GroupProject;
  machine: string;
  write: QueuedWrite;
  /** The author as a host-relative member address: `agentId@<sending machine>`. */
  address: string;
  isMember: boolean;
  action: RemoteWriteAction;
}
export type RemoteWriteGate = (check: RemoteWriteCheck) => Promise<string | undefined> | string | undefined;

/** The person, on any of their computers: an author with no agent, labelled as the user. */
const isPersonAuthor = (author: WriteAuthor): boolean => !author.agentId && author.label === 'user';

/** Membership fields kept per member address; a computer may set only its own agents' entries. */
const PER_ADDRESS_FIELDS = new Set(['subscriptions', 'disabledTools']);

/** A computer's own housekeeping changes only its own agents' membership entries. */
function patchForMachine(patch: MembershipPatch, machine: string, current: GroupProjectMembership): MembershipPatch {
  const own = (address: string) => parseAgentAddress(address).machine === machine;
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch.set)) {
    if (!PER_ADDRESS_FIELDS.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const merged: Record<string, unknown> = { ...((current[key] as Record<string, unknown> | undefined) ?? {}) };
    for (const address of Object.keys(merged)) if (own(address)) delete merged[address];
    for (const [address, entry] of Object.entries(value as Record<string, unknown>)) if (own(address)) merged[address] = entry;
    set[key] = merged;
  }
  return {
    addExplicit: patch.addExplicit.filter((e) => own(e.address)),
    removeExplicit: patch.removeExplicit.filter(own),
    addExcluded: patch.addExcluded.filter((e) => own(e.address)),
    removeExcluded: patch.removeExcluded.filter(own),
    set,
  };
}

type OutboxItem = QueuedWrite & { host: string };
interface StoredList<T> { version: 1; items: T[] }
interface ReplicaState { version: 1; syncedAt?: string; hostRemoved?: boolean }
/** A copy this computer dropped: deleted on its host, or no longer shared as of `seq`. */
interface ReplicaTombstone { groupProjectId: string; host: string; seq: number; at: string; kind: 'deleted' | 'unshared'; viewsPurged?: boolean }
/** What a host answered a remote write, kept so a replayed write gets the same answer. */
interface AppliedWrite { machine: string; id: string; result: WriteResult; at: string }

const APPLIED_MAX = 2000;
const APPLIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OUTBOX_MAX_PER_PROJECT = 200;
const OUTBOX_MAX_TOTAL = 1000;
const OUTBOX_EXPIRY_MS = 24 * 60 * 60 * 1000;
const FLUSH_BATCH = 20;
const REFUSALS_MAX = 200;

function validateStoredList<T>(value: unknown): StoredList<T> {
  const v = value as Partial<StoredList<T>> | null;
  if (!v || typeof v !== 'object' || v.version !== 1 || !Array.isArray(v.items)) throw new Error('Group project network state is not a valid version 1 record.');
  return { version: 1, items: v.items };
}

function validateReplicaState(value: unknown): ReplicaState {
  const v = value as Partial<ReplicaState> | null;
  if (!v || typeof v !== 'object' || v.version !== 1) throw new Error('Group project copy state is not a valid version 1 record.');
  return { version: 1, ...(typeof v.syncedAt === 'string' && { syncedAt: v.syncedAt }), ...(v.hostRemoved === true && { hostRemoved: true }) };
}

const stripHost = ({ host: _host, ...item }: OutboxItem): QueuedWrite => item;

/** The group projects whose queue the current async context holds through exclusive(). */
const exclusiveScope = new AsyncLocalStorage<ReadonlySet<string>>();

interface HostState { version: 1; seq: number }

/** Tombstones are kept this long, and at most this many. */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TOMBSTONE_MAX = 1000;

function validateHostState(value: unknown): HostState {
  const v = value as Partial<HostState> | null;
  if (!v || typeof v !== 'object' || v.version !== 1 || !Number.isSafeInteger(v.seq) || (v.seq as number) < 0) {
    throw new Error('Group project host state is not a valid version 1 record.');
  }
  return { version: 1, seq: v.seq as number };
}

function validateTombstones(value: unknown): GroupProjectTombstone[] {
  if (!Array.isArray(value)) throw new Error('Group project tombstones are not a list.');
  return value.map((t) => {
    if (!t || typeof t !== 'object' || typeof t.groupProjectId !== 'string' || !Number.isSafeInteger(t.seq)
      || typeof t.deletedAt !== 'string' || !t.host || typeof t.host !== 'object'
      || (t.host.machine !== null && typeof t.host.machine !== 'string')
      || (t.state !== undefined && t.state !== 'deleting' && t.state !== 'deleted')) {
      throw new Error('Group project tombstones contain an invalid entry.');
    }
    return {
      groupProjectId: t.groupProjectId, host: { machine: t.host.machine }, seq: t.seq, deletedAt: t.deletedAt,
      state: t.state === 'deleting' ? 'deleting' : 'deleted',
    };
  });
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface CommitContext {
  project: GroupProject;
  /** Take the next sequence number, saved before the change is made. Call it only when something will change. */
  reserve: () => Promise<number>;
}

class GroupProjectHostService {
  private queues = new Map<string, Promise<unknown>>();
  private seqs = new Map<string, number>();
  private tombstones: GroupProjectTombstone[] | null = null;
  private reconciled: Promise<void> | null = null;
  private listeners = new Set<ChangeListener>();
  private memberResolver: GroupProjectMemberResolver | null = null;
  private link: GroupProjectNetworkLink | null = null;
  private remoteWriteGate: RemoteWriteGate | null = null;
  private outbox: OutboxItem[] | null = null;
  private refusals: GroupProjectNetworkRefusal[] | null = null;
  /** Forwarding and flushing to one host, in order (#3363). */
  private hostChains = new Map<string, Promise<unknown>>();
  /** Catch-up from one host, one at a time, whoever asks. */
  private syncChains = new Map<string, Promise<unknown>>();
  /** Every read-modify-write of the outbox, refusals and remote-write outcomes. */
  private fileChains = new Map<string, Promise<unknown>>();
  /** Writes from one sending computer, applied in order. */
  private senderChains = new Map<string, Promise<unknown>>();
  private replicaTombstones: ReplicaTombstone[] | null = null;
  private appliedWrites: AppliedWrite[] | null = null;

  // ── Identity ─────────────────────────────────────────────────────────────

  /** This machine's Annex fingerprint, or null with no lasting identity. */
  selfMachine(): string | null {
    if (annexEphemeralSession()) return null;
    try {
      return annexIdentity.getIdentity()?.fingerprint.toLowerCase() ?? null;
    } catch {
      // telemetry-exempt: an unreadable identity means no lasting fingerprint; annex-identity logs it
      return null;
    }
  }

  /**
   * The machine addresses are relative to. A null host is this machine, so this
   * machine's own fingerprint canonicalizes to the bare id for every record.
   */
  private hostMachineOf(project: GroupProject): string | null {
    return project.host?.machine ?? this.selfMachine();
  }

  /** Whether a host is this machine. Null is the machine whose registry holds the record. */
  isThisMachine(host: GroupProjectHost | undefined): boolean {
    const machine = host?.machine ?? null;
    return machine === null || machine === this.selfMachine();
  }

  // ── Serialization and sequence numbers ──────────────────────────────────

  private run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (exclusiveScope.getStore()?.has(id)) {
      // Queuing behind the exclusive() that is running this call would wait forever.
      const error = new GroupProjectHostError('invalid', `A host write to ${id} inside exclusive() must pass { withinExclusive: true }.`);
      appLog('core:group-project', 'warn', error.message, { meta: { id, stack: error.stack } });
      return Promise.reject(error);
    }
    const previous = this.queues.get(id) ?? Promise.resolve();
    const step = (): Promise<T> => fn();
    const next: Promise<T> = previous.then(step, step);
    const settle = (): void => undefined;
    const tail: Promise<void> = next.then(settle, settle);
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return next;
  }

  /** Run `fn` after everything queued under `key` in `chains` has settled. */
  private serial<T>(chains: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const step = (): Promise<T> => fn();
    const next: Promise<T> = previous.then(step, step);
    const settle = (): void => undefined;
    const tail: Promise<void> = next.then(settle, settle);
    chains.set(key, tail);
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return next;
  }

  private async seqOf(id: string): Promise<number> {
    let seq = this.seqs.get(id);
    if (seq === undefined) {
      seq = (await readJsonFile(hostStatePath(id), (): HostState => ({ version: 1, seq: 0 }), validateHostState)).seq;
      this.seqs.set(id, seq);
    }
    return seq;
  }

  private async reserveSeq(id: string): Promise<number> {
    const next = (await this.seqOf(id)) + 1;
    await writeJsonFile(hostStatePath(id), { version: 1, seq: next } satisfies HostState);
    this.seqs.set(id, next);
    return next;
  }

  private emit(change: GroupProjectChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // telemetry-exempt: a listener's failure isn't the writer's; listeners report their own
      }
    }
  }

  private async requireProject(id: string): Promise<GroupProject> {
    assertGroupProjectId(id);
    await this.reconcile();
    const project = await groupProjectRegistry.get(id);
    if (!project) throw new GroupProjectHostError('not_found', `Group project ${id} not found.`);
    return project;
  }

  /**
   * One sequenced change. `apply` calls `reserve()` before it writes; a change
   * that turns out to change nothing doesn't reserve, and nothing is announced.
   */
  private async commit<T>(id: string, part: GroupProjectChangePart, apply: (ctx: CommitContext) => Promise<T>, inQueue = false): Promise<T> {
    const body = async () => {
      const project = await this.requireProject(id);
      let seq: number | undefined;
      const reserve = async () => {
        if (seq === undefined) seq = await this.reserveSeq(id);
        return seq;
      };
      const result = await apply({ project, reserve });
      if (seq !== undefined) this.emit({ groupProjectId: id, seq, part });
      return result;
    };
    return inQueue ? body() : this.run(id, body);
  }

  // ── Tombstones and crash recovery ────────────────────────────────────────

  private async loadTombstones(): Promise<GroupProjectTombstone[]> {
    if (!this.tombstones) this.tombstones = await readJsonFile(tombstonesPath(), (): GroupProjectTombstone[] => [], validateTombstones);
    return this.tombstones;
  }

  private async tombstoneOf(id: string): Promise<GroupProjectTombstone | undefined> {
    return (await this.loadTombstones()).find((t) => t.groupProjectId === id);
  }

  /** Save the tombstones with `next` replacing any for its id. A pending one, or one whose data remains, is never pruned. */
  private async saveTombstone(next: GroupProjectTombstone): Promise<void> {
    const now = Date.now();
    const kept = (await this.loadTombstones())
      .filter((t) => t.groupProjectId !== next.groupProjectId)
      .filter((t, i, all) => t.state === 'deleting' || fs.existsSync(groupProjectDir(t.groupProjectId))
        || (now - Date.parse(t.deletedAt) < TOMBSTONE_TTL_MS && i >= all.length - (TOMBSTONE_MAX - 1)));
    const tombstones = [...kept, next];
    await writeJsonFile(tombstonesPath(), tombstones);
    this.tombstones = tombstones;
  }

  /**
   * A delete that finished its tombstone but not its cleanup is completed on the
   * next start. A `deleting` one is left alone: its cascade (#3364) finishes it.
   */
  private reconcile(): Promise<void> {
    if (!this.reconciled) {
      this.reconciled = (async () => {
        for (const tombstone of await this.loadTombstones()) {
          if (tombstone.state === 'deleting') continue;
          if (await groupProjectRegistry.hasRecord(tombstone.groupProjectId)) {
            appLog('core:group-project', 'warn', 'Finishing an interrupted group project delete', { meta: { id: tombstone.groupProjectId } });
            await groupProjectRegistry.delete(tombstone.groupProjectId);
            await groupProjectRegistry.flush();
          }
          // Also when the record is gone: an earlier removal of its data may have failed.
          // A leftover directory is logged and retried next start, not a reason to refuse every group project.
          await destroyBulletinBoard(tombstone.groupProjectId);
        }
      })().catch((err) => {
        this.reconciled = null;
        throw err;
      });
    }
    return this.reconciled;
  }

  async listTombstones(): Promise<GroupProjectTombstone[]> {
    return (await this.loadTombstones()).map((t) => ({ ...t, host: { ...t.host } }));
  }

  /** Deletes begun but not finished, for the delete cascade's recovery (#3364). */
  async listPendingDeletes(): Promise<GroupProjectTombstone[]> {
    return (await this.listTombstones()).filter((t) => t.state === 'deleting');
  }

  // ── Records ──────────────────────────────────────────────────────────────

  private async view(project: GroupProject): Promise<GroupProject> {
    const network = await this.networkView(project).catch((): undefined => undefined);
    return {
      ...project, host: { machine: project.host?.machine ?? null }, seq: await this.seqOf(project.id).catch(() => 0),
      hostName: this.hostNameOf(project), ...(network && { network }),
    };
  }

  async list(): Promise<GroupProject[]> {
    await this.reconcile();
    return Promise.all((await groupProjectRegistry.list()).map((p) => this.view(p)));
  }

  async get(id: string): Promise<GroupProject | null> {
    assertGroupProjectId(id);
    await this.reconcile();
    const project = await groupProjectRegistry.get(id);
    return project ? this.view(project) : null;
  }

  async create(name: string, options?: GroupProjectCreateOptions): Promise<GroupProject> {
    await this.reconcile();
    const tombstoned = new Set((await this.loadTombstones()).map((t) => t.groupProjectId));
    const network = this.scopeOptions().network;
    const created = await groupProjectRegistry.create(
      name, options, { machine: this.selfMachine() },
      (input, registered) => resolveGroupProjectScope(input, registered, network), (id) => !tombstoned.has(id),
    );
    await this.commit(created.id, 'record', async ({ reserve }) => {
      const seq = await reserve();
      // A new group project has no wire members to carry over: its scope decides from the start (#3355).
      await writeMembershipFile(created.id, { ...emptyMembership(), scopeMembersRecorded: 'wire-3355' });
      try {
        await ensureProjectChannels(created.id, seq);
      } catch (err) {
        // telemetry-exempt: logged; the group project exists and channels are seeded again on first join
        appLog('core:group-project', 'warn', 'Failed to seed project channels', {
          meta: { projectId: created.id, error: err instanceof Error ? err.message : String(err) },
        });
      }
    });
    return this.view(created);
  }

  async update(
    id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }, options: { withinExclusive?: boolean; author?: WriteAuthor } = {},
  ): Promise<GroupProject | null> {
    const replica = await this.replicaFor(id).catch((): null => null);
    if (replica) {
      const current = await this.view(replica);
      return this.forward(replica, { op: 'update', fields }, options.author ?? { label: 'user' }, () => current, () => current)
        .then(async () => this.get(id));
    }
    try {
      return await this.commit(id, 'record', async ({ project, reserve }) => {
        const unchanged = (['name', 'description', 'instructions'] as const).every((key) => fields[key] === undefined || fields[key] === project[key])
          && (fields.metadata === undefined || sameJson({ ...project.metadata, ...fields.metadata }, project.metadata));
        if (unchanged) return this.view(project);
        await reserve();
        const updated = await groupProjectRegistry.update(id, fields);
        return updated && this.view(updated);
      }, options.withinExclusive);
    } catch (err) {
      // telemetry-exempt: update of an absent group project answers null, as before; anything else rethrows
      if (err instanceof GroupProjectHostError && err.code === 'not_found') return null;
      throw err;
    }
  }

  /**
   * Run `fn` with this group project's writes held, so nothing changes it
   * meanwhile. Host writes inside `fn` pass `withinExclusive`.
   */
  exclusive<T>(id: string, fn: (current: { project: GroupProject; seq: number }) => Promise<T>): Promise<T> {
    return this.run(id, async () => {
      const project = await this.view(await this.requireProject(id));
      return this.holding(id, () => fn({ project, seq: project.seq ?? 0 }));
    });
  }

  /**
   * Begin deleting: save a `deleting` tombstone, hide the group project from
   * every reader and refuse further writes, then announce `deleted`. The record
   * and data stay until `finishDelete`, so a cascade can clean up around them and
   * recover after a crash. With `expectedSeq`, refuses (`changed`) if anything
   * changed since.
   */
  beginDelete(id: string, options: { expectedSeq?: number; withinExclusive?: boolean } = {}): Promise<GroupProjectTombstone> {
    assertGroupProjectId(id);
    const body = async () => {
      const project = await this.requireProject(id);
      if (this.isReplica(project)) throw this.notHost(project, 'delete');
      const current = await this.seqOf(id);
      if (options.expectedSeq !== undefined && options.expectedSeq !== current) {
        throw new GroupProjectHostError('changed', 'The group project changed after its impact was shown. Review it again before deleting.');
      }
      const tombstone: GroupProjectTombstone = {
        groupProjectId: id, host: { machine: project.host?.machine ?? null }, seq: current + 1,
        deletedAt: new Date().toISOString(), state: 'deleting',
      };
      const last = await this.view(project);
      await this.saveTombstone(tombstone);
      await groupProjectRegistry.hide(id);
      this.emit({ groupProjectId: id, seq: tombstone.seq, part: 'deleted', project: last });
      return { ...tombstone, host: { ...tombstone.host } };
    };
    return options.withinExclusive ? body() : this.run(id, body);
  }

  /**
   * Finish a begun delete, once its cascade is done: mark the tombstone
   * `deleted`, then remove the record and the board, membership and sequence
   * state. Safe to repeat. A failed removal rejects, and the next start retries
   * it from the `deleted` tombstone.
   */
  finishDelete(id: string, options: { withinExclusive?: boolean } = {}): Promise<GroupProjectTombstone> {
    assertGroupProjectId(id);
    const body = async () => {
      const tombstone = await this.tombstoneOf(id);
      if (!tombstone) throw new GroupProjectHostError('not_found', `Group project ${id} has no delete in progress.`);
      const done: GroupProjectTombstone = { ...tombstone, state: 'deleted' };
      if (tombstone.state !== 'deleted') await this.saveTombstone(done);
      if (await groupProjectRegistry.hasRecord(id)) {
        await groupProjectRegistry.delete(id);
        await groupProjectRegistry.flush();
      }
      this.seqs.delete(id);
      await destroyBulletinBoard(id, { strict: true });
      return { ...done, host: { ...done.host } };
    };
    return options.withinExclusive ? body() : this.run(id, body);
  }

  /** Run `fn` with `id` marked as held by this async context, so a queued write from inside it fails fast. */
  private holding<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const held = new Set(exclusiveScope.getStore() ?? []);
    held.add(id);
    return exclusiveScope.run(held, fn);
  }

  /** Run `fn` in a tombstoned group project's queue, after its record is hidden or gone (#3364 recovery). */
  exclusivePending<T>(id: string, fn: (tombstone: GroupProjectTombstone) => Promise<T>): Promise<T> {
    assertGroupProjectId(id);
    return this.run(id, async () => {
      const tombstone = await this.tombstoneOf(id);
      if (!tombstone) throw new GroupProjectHostError('not_found', `Group project ${id} has no delete in progress.`);
      return this.holding(id, () => fn({ ...tombstone, host: { ...tombstone.host } }));
    });
  }

  /**
   * Delete a group project in one step: `beginDelete` then `finishDelete`. A
   * failed cleanup rejects after `deleted` was announced, and the next start
   * finishes it. Returns `{ deleted: false }` for an unknown or already deleted id.
   */
  async delete(id: string, options: { expectedSeq?: number; withinExclusive?: boolean } = {}): Promise<{ deleted: boolean; tombstone?: GroupProjectTombstone }> {
    assertGroupProjectId(id);
    const body = async () => {
      await this.reconcile();
      const existing = await groupProjectRegistry.get(id);
      if (!existing) return { deleted: false };
      if (this.isReplica(existing)) throw this.notHost(existing, 'delete');
      await this.beginDelete(id, { expectedSeq: options.expectedSeq, withinExclusive: true });
      return { deleted: true, tombstone: await this.finishDelete(id, { withinExclusive: true }) };
    };
    return options.withinExclusive ? body() : this.run(id, body);
  }

  // ── Membership ───────────────────────────────────────────────────────────

  async getMembership(id: string): Promise<GroupProjectMembership> {
    const project = await this.requireProject(id);
    return readMembershipFile(id, this.hostMachineOf(project));
  }

  /** Change the membership record. `fn` edits a copy; a throw changes nothing. */
  async updateMembership(
    id: string, fn: (draft: GroupProjectMembership) => GroupProjectMembership | void, options: { withinExclusive?: boolean } = {},
  ): Promise<{ membership: GroupProjectMembership; seq: number; queued?: boolean }> {
    const replica = await this.replicaFor(id).catch((): null => null);
    if (replica) {
      // A copy sends the change as a patch, applied by the host to its own current record.
      const hostMachine = this.hostMachineOf(replica);
      const current = await readMembershipFile(id, hostMachine);
      const draft = structuredClone(current);
      const next = validateMembership(fn(draft) ?? draft, hostMachine);
      const patch = membershipPatch(current, next);
      const seq = await this.seqOf(id);
      if (isEmptyPatch(patch)) return { membership: current, seq };
      return this.forward(replica, { op: 'membership', patch }, { label: 'membership' },
        () => ({ membership: next, seq }), () => ({ membership: next, seq, queued: true }));
    }
    return this.commit(id, 'membership', async ({ project, reserve }) => {
      const hostMachine = this.hostMachineOf(project);
      const current = await readMembershipFile(id, hostMachine);
      const draft = structuredClone(current);
      const next = validateMembership(fn(draft) ?? draft, hostMachine);
      if (sameJson(current, next)) return { membership: current, seq: await this.seqOf(id) };
      const seq = await reserve();
      await writeMembershipFile(id, next);
      return { membership: next, seq };
    }, options.withinExclusive);
  }

  /** #3357 registers who is a member; until then, wires decide. */
  setMemberResolver(resolver: GroupProjectMemberResolver | null): void {
    this.memberResolver = resolver;
  }

  async resolveMembers(id: string): Promise<GroupProjectMemberView[]> {
    const project = await this.requireProject(id);
    if (this.memberResolver) return this.memberResolver(await this.view(project), await this.getMembership(id));
    const projects = await this.agentProjects();
    const seen = new Set<string>();
    const members: GroupProjectMemberView[] = [];
    for (const b of bindingManager.getAllBindings()) {
      if (b.targetKind !== 'group-project' || b.targetId !== id) continue;
      const address = this.addressOf(project, b.agentId);
      if (seen.has(address)) continue;
      seen.add(address);
      const projectId = projects.get(b.agentId);
      members.push({ address, name: b.agentName || b.agentId, ...(projectId && { projectId }) });
    }
    return members;
  }

  /** Each local agent's registered project: durable agents from their configs, others from their live registration. */
  private async agentProjects(): Promise<Map<string, string>> {
    return new Map([...(await this.agentFacts())].map(([id, fact]) => [id, fact.projectId]));
  }

  private async agentFacts(): Promise<Map<string, { projectId: string; name?: string }>> {
    const projects = await projectStore.list();
    const byAgent = new Map<string, { projectId: string; name?: string }>();
    for (const project of projects) {
      // Unreadable is not empty: its agents stay unknown, so a new join from it is refused
      // and a current member of it is never counted as leaving.
      let agents: readonly { id: string }[] = [];
      try {
        const read = await agentConfig.peekDurableConfigsChecked(project.path);
        if (read.readable) agents = read.agents;
        else appLog('core:group-project', 'warn', 'Could not read agents for group project scope', { meta: { projectId: project.id } });
      } catch (err) {
        // telemetry-exempt: logged; the project's agents stay unknown
        appLog('core:group-project', 'warn', 'Could not read agents for group project scope', {
          meta: { projectId: project.id, error: err instanceof Error ? err.message : String(err) },
        });
      }
      for (const agent of agents as ReadonlyArray<{ id: string; name?: string }>) byAgent.set(agent.id, { projectId: project.id, ...(agent.name && { name: agent.name }) });
    }
    for (const [agentId, registration] of agentRegistry.getAllRegistrations()) {
      if (byAgent.has(agentId)) continue;
      const project = projects.find((p) => p.path === registration.projectPath);
      if (project) byAgent.set(agentId, { projectId: project.id });
    }
    return byAgent;
  }

  // ── Scope (#3355) ────────────────────────────────────────────────────────

  /** Whether network reach can be chosen now, and why not. */
  scopeOptions(): GroupProjectScopeOptions {
    if (!networkEnabled()) {
      return { network: { available: false, reason: 'Network reach needs Annex Network. Turn it on in Settings > Annex Network.' } };
    }
    if (!this.selfMachine()) {
      return { network: { available: false, reason: 'Network reach needs this computer in an Annex Network. Add a device in Settings > Annex Network first.' } };
    }
    return { network: { available: true } };
  }

  private async resolveScope(scope: unknown): Promise<GroupProjectScope> {
    const registered = new Set((await projectStore.list()).map((project) => project.id));
    try {
      return resolveGroupProjectScope({ scope }, registered, this.scopeOptions().network);
    } catch (err) {
      if (err instanceof GroupProjectScopeError) {
        throw new GroupProjectHostError(err.code === 'network_unavailable' ? 'network_unavailable' : 'invalid', err.message);
      }
      throw err;
    }
  }

  /** Who would leave if the scope changed to `scope`; nothing changes. */
  async previewScope(id: string, scope: unknown): Promise<{ scope: GroupProjectScope; leaving: GroupProjectMemberView[]; returning: GroupProjectMemberView[] }> {
    const next = await this.resolveScope(scope);
    const project = await this.requireProject(id);
    return {
      scope: next,
      leaving: membersLeavingScope(next, await this.resolveMembers(id)),
      returning: await this.returningWith(project, next),
    };
  }

  /** Agents a scope moved out (excluded for scope) that `next` covers again: widening lets them back. */
  private async returningWith(project: GroupProject, next: GroupProjectScope): Promise<GroupProjectMemberView[]> {
    const hostMachine = this.hostMachineOf(project);
    const membership = await readMembershipFile(project.id, hostMachine);
    const facts = await this.agentFacts();
    return membership.excluded.flatMap((entry): GroupProjectMemberView[] => {
      if (entry.reason !== 'scope') return [];
      const agentId = this.localAgentId(project, entry.address);
      const fact = agentId ? facts.get(agentId) : undefined;
      if (memberInScope(next, { address: entry.address, projectId: fact?.projectId }) !== true) return [];
      return [{ address: entry.address, name: fact?.name ?? agentId ?? entry.address, ...(fact && { projectId: fact.projectId }) }];
    });
  }

  /**
   * Change a group project's scope. When members would leave, `confirmLeaving`
   * must list exactly their addresses, as shown by `previewScope`; otherwise
   * it refuses (`changed`) so the person reviews again. Members that leave lose
   * their live bindings and explicit entries.
   */
  async setScope(
    id: string, scope: unknown, options: { confirmLeaving?: readonly string[]; withinExclusive?: boolean } = {},
  ): Promise<{ project: GroupProject; left: GroupProjectMemberView[] }> {
    const next = await this.resolveScope(scope);
    const replica = await this.replicaFor(id).catch((): null => null);
    if (replica) throw this.notHost(replica, 'change the scope of');
    return this.commit(id, 'record', async ({ project, reserve }) => {
      if (project.scope && sameGroupProjectScope(project.scope, next)) return { project: await this.view(project), left: [] };
      // Shared with the network, a group project names its host by fingerprint: this computer.
      const self = this.selfMachine();
      if (next.reach === 'network' && !project.host?.machine && self) await groupProjectRegistry.pinHost(id, self);
      const leaving = membersLeavingScope(next, await this.resolveMembers(id));
      const returning = new Set((await this.returningWith(project, next)).map((member) => member.address));
      const confirmed = new Set(options.confirmLeaving ?? []);
      if (leaving.length !== confirmed.size || leaving.some((member) => !confirmed.has(member.address))) {
        throw new GroupProjectHostError('changed', 'The members who would leave have changed. Review the scope change again.');
      }
      const seq = await reserve();
      const updated = await groupProjectRegistry.setScope(id, next);
      const hostMachine = this.hostMachineOf(project);
      const leavingAddresses = new Set(leaving.map((member) => member.address));
      if (leaving.length > 0 || returning.size > 0) {
        // Leavers are excluded, so neither a restore nor auto-join brings them back.
        // Scope exclusions the new scope covers are lifted: those agents may join again.
        const membership = await readMembershipFile(id, hostMachine);
        const explicit = membership.explicit.filter((entry) => !leavingAddresses.has(entry.address));
        const kept = membership.excluded.filter((entry) => !returning.has(entry.address));
        const already = new Set(kept.map((entry) => entry.address));
        const excludedAt = new Date().toISOString();
        const excluded = [
          ...kept,
          ...[...leavingAddresses].filter((address) => !already.has(address)).map((address) => ({ address, excludedAt, reason: 'scope' })),
        ];
        await writeMembershipFile(id, validateMembership({ ...membership, explicit, excluded }, hostMachine));
        for (const b of bindingManager.getAllBindings()) {
          if (b.targetKind === 'group-project' && b.targetId === id && leavingAddresses.has(this.addressOf(project, b.agentId))) {
            bindingManager.unbind(b.agentId, id);
          }
        }
      }
      appLog('core:group-project', 'info', 'Group project scope changed', { meta: { id, seq, scope: next, left: leaving.length } });
      return { project: await this.view(updated ?? project), left: leaving };
    }, options.withinExclusive);
  }

  /**
   * Once per group project (#3355 upgrade): record every agent bound to a
   * project-scoped group project as an explicit member, so its scope only
   * decides new joins and no current member is dropped. Helpers are recorded as
   * helpers; quick agents and agents on other machines are left to their runs.
   * Returns how many members were recorded.
   */
  async recordScopedWireMembers(): Promise<number> {
    const durable = new Map<string, { parentAgentId?: string }>();
    for (const project of await projectStore.list()) {
      try {
        const read = await agentConfig.peekDurableConfigsChecked(project.path);
        // A partial inventory would record too few members and mark the group project done: try again next rebuild.
        if (!read.readable) return 0;
        for (const agent of read.agents) durable.set(agent.id, agent);
      } catch {
        // telemetry-exempt: an unreadable project means the inventory is partial; the next rebuild tries again
        return 0;
      }
    }
    let recorded = 0;
    for (const gp of await this.list()) {
      if (gp.scope?.level !== 'project' || !this.isThisMachine(gp.host)) continue;
      const current = await this.getMembership(gp.id);
      // A managed record (#3357) holds its own members; only wire-membership group projects need carrying over.
      if (current.scopeMembersRecorded || current.autoJoin || current.autoJoinOffer !== undefined) continue;
      const bound = bindingManager.getAllBindings().filter((b) => b.targetKind === 'group-project' && b.targetId === gp.id);
      await this.updateMembership(gp.id, (draft) => {
        if (draft.scopeMembersRecorded || draft.autoJoin || draft.autoJoinOffer !== undefined) return;
        draft.scopeMembersRecorded = 'wire-3355';
        const addedAt = new Date().toISOString();
        for (const binding of bound) {
          const config = durable.get(binding.agentId);
          if (!config) continue;
          const address = this.addressOf(gp, binding.agentId);
          if (draft.explicit.some((e) => e.address === address) || draft.excluded.some((e) => e.address === address)) continue;
          draft.explicit.push({
            address, kind: config.parentAgentId ? 'helper' : 'durable', addedAt,
            ...(binding.agentName && { name: binding.agentName }), migratedFrom: 'wire-3355',
          });
          recorded++;
        }
      });
    }
    return recorded;
  }

  /**
   * Whether an agent here is within a group project's scope (#3355), for an
   * explicit add. Fails closed: an unknown group project or project refuses.
   * A legacy record with no scope has nothing to check against.
   */
  async inScope(id: string, agentId: string): Promise<boolean> {
    const project = await groupProjectRegistry.get(id);
    if (!project) return false;
    if (!project.scope) return true;
    return (await this.inScopeHere(project, agentId, this.addressOf(project, agentId))) === true;
  }

  /** Refused for its scope: exclude the agent, so a stored wire coming back is refused too. */
  async excludeOutOfScope(id: string, agentId: string): Promise<void> {
    const project = await this.requireProject(id);
    const address = this.addressOf(project, agentId);
    await this.updateMembership(id, (draft) => {
      if (draft.excluded.some((e) => e.address === address) || draft.explicit.some((e) => e.address === address)) return;
      draft.excluded.push({ address, excludedAt: new Date().toISOString(), reason: 'scope' });
    });
  }

  /**
   * Whether an agent here is in a group project's scope. On a copy of a
   * project-scoped network group project, this computer's project counts when
   * it has the host project's repository key (#3363). Undefined when unknown.
   */
  private async inScopeHere(project: GroupProject, agentId: string, address: string): Promise<boolean | undefined> {
    const scope = project.scope!;
    if (scope.level !== 'project' || !this.isReplica(project)) {
      const projectId = scope.level === 'project' ? (await this.agentProjects()).get(agentId) : undefined;
      return memberInScope(scope, { address, projectId });
    }
    const projectId = (await this.agentProjects()).get(agentId);
    const local = projectId ? (await projectStore.list()).find((p) => p.id === projectId) : undefined;
    if (!local || !project.scopeProjectKey) return undefined;
    try {
      return (await agentConfig.projectKey(local.path)) === project.scopeProjectKey;
    } catch {
      // telemetry-exempt: an unknown repository is neither in nor out
      return undefined;
    }
  }

  /** The message for an agent outside a group project's scope. */
  outOfScopeMessage(project: GroupProject, agentName: string): string {
    return `${agentName} is outside the scope of "${project.name}", so it can't join. Widen the scope in Settings > Group Projects first.`;
  }

  /**
   * Whether an agent here may join (#3355). A restore of a stored wire: yes,
   * unless excluded. A drawn wire: an explicit member yes; otherwise only within
   * the scope (so a redraw lifts a person's exclusion but never a scope
   * refusal), failing closed when its project can't be known.
   */
  async admits(id: string, agentId: string, options: { restore?: boolean } = {}): Promise<boolean> {
    const project = await groupProjectRegistry.get(id);
    if (!project) return false;
    const hostMachine = this.hostMachineOf(project);
    const address = this.addressOf(project, agentId);
    const membership = await readMembershipFile(id, hostMachine);
    // A stored wire coming back: refused when excluded, otherwise a pair that was already
    // a member, which a check never evicts.
    if (options.restore) return !membership.excluded.some((entry) => entry.address === address);
    // A drawn wire is a person's choice: it may lift an exclusion (#3357), but only within scope.
    if (membership.explicit.some((entry) => entry.address === address)) return true;
    // No recorded scope (an unresolved legacy record) has nothing to check against.
    if (!project.scope) return true;
    // A new join fails closed: an agent whose project can't be known is not admitted.
    return (await this.inScopeHere(project, agentId, address)) === true;
  }

  /**
   * The id of the agent on this machine that a member address names, or null
   * when it names an agent on another machine (#3363). Addresses are relative
   * to the group project's host: a bare id is an agent on the host, so on a
   * cached copy of a group project hosted elsewhere it is not local.
   */
  localAgentId(project: GroupProject, address: string): string | null {
    const parsed = parseAgentAddress(address.trim());
    const machine = parsed.machine ?? this.hostMachineOf(project);
    const self = this.selfMachine();
    return machine === null || machine === self ? parsed.agentId : null;
  }

  /**
   * The host-relative address for a reference made on this computer: a bare id
   * is an agent here (qualified with this machine on a copy of a group project
   * hosted elsewhere), and a qualified one is normalized.
   */
  addressOf(project: GroupProject, reference: string): string {
    const parsed = parseAgentAddress(reference.trim());
    return parsed.machine
      ? canonicalMemberAddress(reference, this.hostMachineOf(project))
      : memberAddress(parsed.agentId, this.selfMachine(), this.hostMachineOf(project));
  }

  /** The host-relative address of an agent here or on another machine. */
  memberAddress(project: GroupProject, agentId: string, machine?: string | null): string {
    return memberAddress(agentId, machine ?? this.selfMachine(), this.hostMachineOf(project));
  }

  // ── Board ────────────────────────────────────────────────────────────────
  // Every write takes `withinExclusive` for use inside `exclusive()`.

  async post(
    id: string, sender: string, topic: string, body: string,
    options: { withinExclusive?: boolean; chain?: string[]; author?: WriteAuthor; messageId?: string } = {},
  ): Promise<BulletinMessage> {
    const replica = await this.replicaFor(id);
    if (replica) {
      // A copy forwards to its host, which publishes the post's event where it lands (#3363).
      return this.forward<BulletinMessage>(replica, { op: 'post', sender, topic, body }, options.author ?? { label: sender }, (result) => result as BulletinMessage, (item) => ({
        id: `queued_${item.id}`, sender, topic: normalizeChannelName(topic), body, timestamp: item.queuedAt, pending: { waitingFor: this.hostNameOf(replica) },
      }));
    }
    let replayed = false;
    const message = await this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      // A replayed remote post (#3363) finds the message it made the first time.
      const earlier = options.messageId ? await board.getMessageById(options.messageId) : null;
      if (earlier) {
        replayed = true;
        return earlier;
      }
      return board.postMessage(sender, topic, body, await reserve(), options.messageId);
    }, options.withinExclusive);
    if (!replayed) publishAppEvent({ type: 'group_project.message_posted', groupProjectId: id, topic: message.topic, ...(options.chain && { chain: options.chain }) });
    return message;
  }

  /** False when there's no such message, or no such group project, as before #3356. */
  async deleteMessage(id: string, topic: string, messageId: string, options: { withinExclusive?: boolean; author?: WriteAuthor } = {}): Promise<boolean> {
    const replica = await this.replicaFor(id).catch((): null => null);
    if (replica) return this.forward(replica, { op: 'deleteMessage', topic, messageId }, options.author ?? { label: 'user' }, Boolean, () => true);
    return this.unlessMissing(false, () => this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      const message = await board.getMessageById(messageId);
      if (!message || message.topic !== normalizeChannelName(topic)) return false;
      await reserve();
      return board.deleteMessage(topic, messageId);
    }, options.withinExclusive));
  }

  async deleteTopic(id: string, topic: string, options: { withinExclusive?: boolean; author?: WriteAuthor } = {}): Promise<boolean> {
    const replica = await this.replicaFor(id).catch((): null => null);
    if (replica) return this.forward(replica, { op: 'deleteTopic', topic }, options.author ?? { label: 'user' }, Boolean, () => true);
    return this.unlessMissing(false, () => this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      if (!(await board.hasTopic(topic))) return false;
      await reserve();
      return board.deleteTopic(topic);
    }, options.withinExclusive));
  }

  private async unlessMissing<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // telemetry-exempt: an absent group project is an answer, not a failure; anything else rethrows
      if (err instanceof GroupProjectHostError && err.code === 'not_found') return fallback;
      throw err;
    }
  }

  async setTopicProtected(id: string, topic: string, isProtected: boolean, options: { withinExclusive?: boolean; author?: WriteAuthor } = {}): Promise<void> {
    const replica = await this.replicaFor(id);
    if (replica) return this.forward(replica, { op: 'setTopicProtected', topic, isProtected }, options.author ?? { label: 'user' }, (): undefined => undefined, (): undefined => undefined);
    return this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      await board.hasTopic(topic);
      if (board.isTopicProtected(topic) === isProtected) return;
      await reserve();
      board.setTopicProtected(topic, isProtected);
    }, options.withinExclusive);
  }

  async clearAll(id: string, options: { withinExclusive?: boolean } = {}): Promise<number> {
    const replica = await this.replicaFor(id);
    if (replica) throw this.notHost(replica, 'clear');
    return this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      await board.hasTopic('general');
      if (board.totalMessageCount() === 0) return 0;
      await reserve();
      return board.clearAll();
    }, options.withinExclusive);
  }

  /** Save retention limits and trim the board to them, as one change. Unchanged limits that trim nothing take no number. */
  async setRetention(id: string, maxPerTopic: number, maxTotal: number, options: { withinExclusive?: boolean } = {}): Promise<number> {
    const replica = await this.replicaFor(id);
    if (replica) throw this.notHost(replica, 'change the retention of');
    return this.commit(id, 'record', async ({ project, reserve }) => {
      const board = getBulletinBoard(id);
      await board.hasTopic('general');
      const saved = project.metadata.maxPerTopic === maxPerTopic && project.metadata.maxTotal === maxTotal;
      if (saved && board.estimateTrimCount(maxPerTopic, maxTotal) === 0) {
        // The limits are already the saved ones: applying them in memory changes nothing on disk.
        board.setLimits(maxPerTopic, maxTotal);
        return 0;
      }
      // Applied only once the change has its number, so a failed write leaves no unsaved limits in effect.
      await reserve();
      board.setLimits(maxPerTopic, maxTotal);
      if (!saved) await groupProjectRegistry.update(id, { metadata: { maxPerTopic, maxTotal } });
      return board.trimToLimits();
    }, options.withinExclusive);
  }

  /** Seed `general` and `control` and keep them protected. Changes nothing when they are. */
  async ensureChannels(id: string, options: { withinExclusive?: boolean } = {}): Promise<void> {
    const replica = await this.replicaFor(id);
    if (replica) {
      // A copy has what the host seeded; only ask when something's missing.
      if (await this.channelsReady(id)) return;
      return this.forward(replica, { op: 'ensureChannels' }, { label: 'system' }, (): undefined => undefined, (): undefined => undefined);
    }
    return this.commit(id, 'board', async ({ reserve }) => {
      if (await this.channelsReady(id)) return;
      await ensureProjectChannels(id, await reserve());
    }, options.withinExclusive);
  }

  private async channelsReady(id: string): Promise<boolean> {
    const board = getBulletinBoard(id);
    for (const name of PROJECT_CHANNELS) {
      if (!(await board.hasTopic(name)) || !board.isTopicProtected(name)) return false;
    }
    return true;
  }

  /** Seed a member's inbox, kept apart from any other member with the same name (#1646). Returns its channel. */
  async ensureInbox(id: string, agentName: string, address: string, options: { withinExclusive?: boolean } = {}): Promise<string> {
    const replica = await this.replicaFor(id);
    if (replica) {
      const canonical = this.addressOf(replica, address);
      const board = getBulletinBoard(id);
      const channel = await resolveInboxChannel(id, agentName, canonical);
      if ((await board.inboxOwner(channel)) === canonical && (await board.hasTopic(channel)) && board.isTopicProtected(channel)) return channel;
      return this.forward(replica, { op: 'ensureInbox', agentName, address: canonical }, { label: agentName }, (result) => (typeof result === 'string' ? result : channel), () => channel);
    }
    return this.commit(id, 'board', async ({ project, reserve }) => {
      const canonical = this.addressOf(project, address);
      const board = getBulletinBoard(id);
      const channel = await resolveInboxChannel(id, agentName, canonical);
      if ((await board.inboxOwner(channel)) === canonical && (await board.hasTopic(channel)) && board.isTopicProtected(channel)) return channel;
      return ensureInboxChannel(id, agentName, canonical, await reserve());
    }, options.withinExclusive);
  }

  // ── Board reads ──────────────────────────────────────────────────────────
  // Reads never queue, so they are safe inside `exclusive()`. A group project
  // that doesn't exist, or is hidden by a delete (even one that began during
  // the read), answers as empty, as an unknown id always has.

  private async read<T>(id: string, empty: T, fn: (board: ReturnType<typeof getBulletinBoard>) => Promise<T>): Promise<T> {
    assertGroupProjectId(id);
    await this.reconcile();
    if (!(await groupProjectRegistry.get(id))) return empty;
    const result = await fn(getBulletinBoard(id));
    return (await groupProjectRegistry.get(id)) ? result : empty;
  }

  readDigest(id: string, since?: DigestSince, channels?: string[]): Promise<TopicDigest[]> {
    return this.read(id, [], (board) => board.getDigest(since, channels));
  }

  /** The board's topics, counts and protection. */
  digest(id: string): Promise<TopicDigest[]> {
    return this.readDigest(id);
  }

  readTopic(id: string, topic: string, since?: string, limit?: number): Promise<BulletinMessage[]> {
    return this.read(id, [], (board) => board.getTopicMessages(topic, since, limit));
  }

  readAll(id: string, since?: string, limit?: number): Promise<BulletinMessage[]> {
    return this.read(id, [], (board) => board.getAllMessages(since, limit));
  }

  getMessage(id: string, messageId: string): Promise<BulletinMessage | null> {
    return this.read<BulletinMessage | null>(id, null, (board) => board.getMessageById(messageId));
  }

  estimateTrim(id: string, maxPerTopic: number, maxTotal: number): Promise<number> {
    return this.read(id, 0, async (board) => {
      await board.hasTopic('general');
      return board.estimateTrimCount(maxPerTopic, maxTotal);
    });
  }

  /** The inbox channel of a member, without changing anything. */
  async inboxFor(id: string, agentName: string, address?: string): Promise<string> {
    const project = await this.requireProject(id);
    return resolveInboxChannel(id, agentName, address && this.addressOf(project, address));
  }

  // ── Network group projects (#3363) ───────────────────────────────────────
  // A network group project is held by its host. Other computers in the Annex
  // Network keep a copy (a replica: a record here whose host is another
  // computer) that follows the host's sequence numbers, and send writes to the
  // host, queued while it is away. group-project-network.ts carries the
  // requests; everything that touches the stores is here.

  /** Set by the network service at startup; tests set a fake. */
  setNetworkLink(link: GroupProjectNetworkLink | null): void {
    this.link = link;
  }

  /** Who the host checks a remote write against (#3360 sets one); none allows every network computer. */
  setRemoteWriteGate(gate: RemoteWriteGate | null): void {
    this.remoteWriteGate = gate;
  }

  /** A cached copy of a group project hosted on another computer. */
  isReplica(project: GroupProject): boolean {
    return !this.isThisMachine(project.host);
  }

  private async replicaFor(id: string): Promise<GroupProject | null> {
    assertGroupProjectId(id);
    const project = await groupProjectRegistry.get(id);
    return project && this.isReplica(project) ? project : null;
  }

  hostNameOf(project: GroupProject): string {
    if (!this.isReplica(project)) return 'This computer';
    return this.link?.machineName(project.host!.machine!) || 'another computer';
  }

  private notHost(project: GroupProject, what: string): GroupProjectHostError {
    return new GroupProjectHostError('not_host', `Only ${this.hostNameOf(project)} can ${what} this group project.`);
  }

  private async loadOutbox(): Promise<OutboxItem[]> {
    if (!this.outbox) this.outbox = (await readJsonFile(networkOutboxPath(), (): StoredList<OutboxItem> => ({ version: 1, items: [] }), validateStoredList<OutboxItem>)).items;
    return this.outbox;
  }

  private async saveOutbox(items: OutboxItem[]): Promise<void> {
    await writeJsonFile(networkOutboxPath(), { version: 1, items } satisfies StoredList<OutboxItem>);
    this.outbox = items;
  }

  /** Change the outbox under one lock, so two writes at once both stay queued. */
  private editOutbox<T>(fn: (items: OutboxItem[]) => { items: OutboxItem[]; result: T }): Promise<T> {
    return this.serial(this.fileChains, 'outbox', async () => {
      const { items, result } = fn([...(await this.loadOutbox())]);
      await this.saveOutbox(items);
      return result;
    });
  }

  private removeFromOutbox(ids: ReadonlySet<string>): Promise<void> {
    return this.editOutbox((items) => ({ items: items.filter((i) => !ids.has(i.id)), result: undefined }));
  }

  private async loadRefusals(): Promise<GroupProjectNetworkRefusal[]> {
    if (!this.refusals) {
      this.refusals = (await readJsonFile(networkRefusalsPath(), (): StoredList<GroupProjectNetworkRefusal> => ({ version: 1, items: [] }), validateStoredList<GroupProjectNetworkRefusal>)).items;
    }
    return this.refusals;
  }

  private async recordRefusal(item: OutboxItem, reason: string): Promise<void> {
    const refusal: GroupProjectNetworkRefusal = {
      id: item.id, groupProjectId: item.groupProjectId, op: item.write.op, reason, at: new Date().toISOString(), author: item.author,
    };
    await this.serial(this.fileChains, 'refusals', async () => {
      const items = [...(await this.loadRefusals()), refusal].slice(-REFUSALS_MAX);
      await writeJsonFile(networkRefusalsPath(), { version: 1, items } satisfies StoredList<GroupProjectNetworkRefusal>);
      this.refusals = items;
    });
    try {
      this.link?.notifyRefusal?.(refusal);
    } catch {
      // telemetry-exempt: the refusal is kept for the directory whatever the notice does
    }
  }

  /** The person has seen a group project's refusals. */
  async dismissRefusals(id: string): Promise<void> {
    await this.serial(this.fileChains, 'refusals', async () => {
      const items = (await this.loadRefusals()).filter((r) => r.groupProjectId !== id);
      await writeJsonFile(networkRefusalsPath(), { version: 1, items } satisfies StoredList<GroupProjectNetworkRefusal>);
      this.refusals = items;
    });
    groupProjectRegistry.touch();
  }

  private async replicaState(id: string): Promise<ReplicaState> {
    return readJsonFile(replicaStatePath(id), (): ReplicaState => ({ version: 1 }), validateReplicaState);
  }

  private async networkView(project: GroupProject): Promise<GroupProjectNetworkState | undefined> {
    if (project.scope?.reach !== 'network') return undefined;
    const refusals = (await this.loadRefusals()).filter((r) => r.groupProjectId === project.id);
    const waitingWrites = (await this.loadOutbox()).filter((i) => i.groupProjectId === project.id).length;
    if (!this.isReplica(project)) return { role: 'host', state: 'online', waitingWrites, refusals };
    const replica = await this.replicaState(project.id).catch((): ReplicaState => ({ version: 1 }));
    const host = project.host!.machine!;
    const state = replica.hostRemoved || (this.link && !this.link.isMember(host)) ? 'host-removed'
      : this.link?.connected(host) ? 'online' : 'cached';
    return { role: 'replica', state, waitingWrites, ...(replica.syncedAt && { syncedAt: replica.syncedAt }), refusals };
  }

  /**
   * A write on a copy goes to its host: at once when the host is connected and
   * nothing waits before it, otherwise into the queue for when it's back. One
   * decision at a time per host, so writes reach it in the order they were made.
   */
  private async forward<T>(project: GroupProject, write: WriteOp, author: WriteAuthor, applied: (result: unknown) => T, queued: (item: OutboxItem) => T): Promise<T> {
    const host = project.host!.machine!;
    const replica = await this.replicaState(project.id).catch((): ReplicaState => ({ version: 1 }));
    if (replica.hostRemoved || (this.link && !this.link.isMember(host))) {
      throw new GroupProjectHostError('read_only', `${this.hostNameOf(project)} left your network. This group project is read-only here.`);
    }
    const item: OutboxItem = {
      id: randomUUID(), host, groupProjectId: project.id, author, queuedAt: new Date().toISOString(), write,
    };
    const outcome = await this.serial(this.hostChains, host, async (): Promise<{ result?: WriteResult }> => {
      const waiting = (await this.loadOutbox()).some((i) => i.host === host);
      if (this.link?.connected(host) && !waiting) {
        let response: WriteResponse | undefined;
        try {
          response = await this.link.sendWrites(host, [stripHost(item)]);
        } catch (err) {
          // telemetry-exempt: the host went away mid-request; the write is queued below, and the
          // host recognizes it by id if it did arrive
          appLog('core:group-project', 'info', 'Host unreachable; queuing the write', { meta: { id: project.id, error: err instanceof Error ? err.message : String(err) } });
        }
        const result = response?.results.find((r) => r.id === item.id);
        if (result) return { result };
      }
      await this.enqueue(project, item);
      return {};
    });
    if (outcome.result?.status === 'applied') {
      await this.syncFrom(host).catch((err: unknown) => {
        // telemetry-exempt: the copy catches up on the host's next notice
        appLog('core:group-project', 'warn', 'Could not catch up after a write', { meta: { id: project.id, error: err instanceof Error ? err.message : String(err) } });
      });
      return applied(outcome.result.result);
    }
    if (outcome.result?.status === 'refused') throw new GroupProjectHostError('refused', `${this.hostNameOf(project)} refused this change: ${outcome.result.reason}`);
    groupProjectRegistry.touch();
    return queued(item);
  }

  private enqueue(project: GroupProject, item: OutboxItem): Promise<void> {
    return this.editOutbox((items) => {
      if (items.length >= OUTBOX_MAX_TOTAL || items.filter((i) => i.groupProjectId === project.id).length >= OUTBOX_MAX_PER_PROJECT) {
        throw new GroupProjectHostError('queue_full', `Too many changes are waiting for ${this.hostNameOf(project)}. Try again when it's back.`);
      }
      return { items: [...items, item], result: undefined };
    });
  }

  /**
   * Send what waits for `host`, in order. Each is applied or refused by the
   * host; a refusal is kept and told to its author. Stops at the first
   * transport failure, to go on at the next connect; a write that may have
   * arrived is sent again with the same id, which the host answers as before.
   * Expired writes are refused here, without sending.
   */
  flushOutbox(host: string): Promise<void> {
    return this.serial(this.hostChains, host, async () => {
      for (;;) {
        const now = Date.now();
        const expired = (await this.loadOutbox()).filter((i) => i.host === host && now - Date.parse(i.queuedAt) > OUTBOX_EXPIRY_MS);
        if (expired.length > 0) {
          await this.removeFromOutbox(new Set(expired.map((i) => i.id)));
          for (const item of expired) await this.recordRefusal(item, `It waited more than a day for ${this.link?.machineName(host) || 'its host'}.`);
        }
        const batch = (await this.loadOutbox()).filter((i) => i.host === host).slice(0, FLUSH_BATCH);
        if (batch.length === 0 || !this.link?.connected(host)) break;
        const response = await this.link.sendWrites(host, batch.map(stripHost));
        const answered: OutboxItem[] = [];
        for (const item of batch) {
          const result = response.results.find((r) => r.id === item.id);
          if (!result) break;
          answered.push(item);
          if (result.status === 'refused') await this.recordRefusal(item, result.reason);
        }
        if (answered.length === 0) break;
        await this.removeFromOutbox(new Set(answered.map((i) => i.id)));
      }
      groupProjectRegistry.touch();
    }).then(() => this.syncFrom(host));
  }

  private async loadReplicaTombstones(): Promise<ReplicaTombstone[]> {
    if (!this.replicaTombstones) {
      this.replicaTombstones = (await readJsonFile(replicaTombstonesPath(), (): StoredList<ReplicaTombstone> => ({ version: 1, items: [] }), validateStoredList<ReplicaTombstone>)).items;
    }
    return this.replicaTombstones;
  }

  /** Recorded before a copy is dropped, so a late answer from its host can't bring it back. */
  private recordReplicaTombstone(tombstone: ReplicaTombstone): Promise<void> {
    return this.serial(this.fileChains, 'replica-tombstones', async () => {
      const now = Date.now();
      const items = [...(await this.loadReplicaTombstones())
        .filter((t) => !(t.groupProjectId === tombstone.groupProjectId && t.host === tombstone.host))
        .filter((t) => now - Date.parse(t.at) < TOMBSTONE_TTL_MS), tombstone].slice(-TOMBSTONE_MAX);
      await writeJsonFile(replicaTombstonesPath(), { version: 1, items } satisfies StoredList<ReplicaTombstone>);
      this.replicaTombstones = items;
    });
  }

  private forgetReplicaTombstone(id: string, host: string): Promise<void> {
    return this.serial(this.fileChains, 'replica-tombstones', async () => {
      const items = (await this.loadReplicaTombstones()).filter((t) => !(t.groupProjectId === id && t.host === host));
      await writeJsonFile(replicaTombstonesPath(), { version: 1, items } satisfies StoredList<ReplicaTombstone>);
      this.replicaTombstones = items;
    });
  }

  /**
   * Every group project removed here: deleted on this computer, or a copy
   * dropped (#3363). A Canvas save naming one of them has it taken out.
   */
  async removedGroupProjectIds(): Promise<string[]> {
    const ids = new Set((await this.loadTombstones()).map((t) => t.groupProjectId));
    for (const t of await this.loadReplicaTombstones()) ids.add(t.groupProjectId);
    return [...ids];
  }

  /** Dropped copies whose Canvas cards and wires haven't been removed yet (a crash or failure since). */
  async pendingViewPurges(): Promise<string[]> {
    return (await this.loadReplicaTombstones()).filter((t) => !t.viewsPurged).map((t) => t.groupProjectId);
  }

  /** A dropped copy's cards, wires and guidance are gone. */
  markViewsPurged(id: string): Promise<void> {
    return this.serial(this.fileChains, 'replica-tombstones', async () => {
      const items = (await this.loadReplicaTombstones()).map((t) => (t.groupProjectId === id ? { ...t, viewsPurged: true } : t));
      await writeJsonFile(replicaTombstonesPath(), { version: 1, items } satisfies StoredList<ReplicaTombstone>);
      this.replicaTombstones = items;
    });
  }

  /** Catch up every copy held of `host`'s group projects, and learn of new ones. One catch-up per host at a time. */
  syncFrom(host: string): Promise<void> {
    return this.serial(this.syncChains, host, () => this.syncFromNow(host));
  }

  private async syncFromNow(host: string): Promise<void> {
    if (!this.link) return;
    await this.reconcile();
    const held = (await groupProjectRegistry.list()).filter((p) => this.isReplica(p) && p.host?.machine === host);
    const known: Record<string, number> = {};
    for (const p of held) known[p.id] = await this.seqOf(p.id).catch(() => 0);
    const response = await this.link.sync(host, { v: 1, known });
    const hostName = this.link.machineName(host);
    const listed = new Set([...response.unchanged, ...response.projects.map((p) => p.record.id)]);
    for (const tombstone of response.tombstones) {
      // Recorded whether or not a copy is held: a snapshot of it is refused from now on.
      await this.recordReplicaTombstone({ groupProjectId: tombstone.groupProjectId, host, seq: tombstone.seq, at: new Date().toISOString(), kind: 'deleted' });
      if (held.some((p) => p.id === tombstone.groupProjectId)) await this.purgeReplica(tombstone.groupProjectId, `It was deleted on ${hostName || 'its host'}.`);
    }
    for (const snapshot of response.projects) {
      if (response.tombstones.some((t) => t.groupProjectId === snapshot.record.id)) continue;
      await this.applySnapshot(host, snapshot);
    }
    for (const p of held) {
      if (!listed.has(p.id) && !response.tombstones.some((t) => t.groupProjectId === p.id)) {
        await this.recordReplicaTombstone({ groupProjectId: p.id, host, seq: known[p.id] ?? 0, at: new Date().toISOString(), kind: 'unshared' });
        await this.purgeReplica(p.id, `${hostName || 'Its host'} no longer shares it with your network.`);
      }
    }
    for (const id of response.unchanged) {
      if (held.some((p) => p.id === id)) await this.markSynced(id);
    }
  }

  private async markSynced(id: string): Promise<void> {
    await writeJsonFile(replicaStatePath(id), { version: 1, syncedAt: new Date().toISOString() } satisfies ReplicaState);
  }

  /** Store the host's current state of one group project as this computer's copy. */
  private applySnapshot(host: string, snapshot: ReplicaSnapshot): Promise<void> {
    const id = snapshot.record.id;
    return this.run(id, async () => {
      if (await groupProjectRegistry.hasRecord(id)) {
        const existing = await groupProjectRegistry.get(id);
        if (existing && !this.isReplica(existing)) {
          appLog('core:group-project', 'warn', 'Ignored a copy of a group project this computer hosts', { meta: { id, host } });
          return;
        }
      }
      if ((await this.loadTombstones()).some((t) => t.groupProjectId === id)) return;
      // A copy dropped for a delete never comes back; one dropped as unshared comes back only when shared again since.
      const dropped = (await this.loadReplicaTombstones()).find((t) => t.groupProjectId === id && t.host === host);
      if (dropped && (dropped.kind === 'deleted' || snapshot.seq <= dropped.seq)) return;
      // Shared again since: its marker goes, so its cards are no longer stripped.
      if (dropped) await this.forgetReplicaTombstone(id, host);
      const { seq: _seq, hostName: _hostName, network: _network, ...record } = snapshot.record;
      const previous = await this.seqOf(id).catch(() => 0);
      // Older than what this copy has: an answer overtaken by a newer one.
      if (previous > 0 && snapshot.seq < previous) return;
      await groupProjectRegistry.putReplica({ ...record, host: { machine: host } });
      await writeMembershipFile(id, validateMembership(snapshot.membership, host));
      const missing = await getBulletinBoard(id).applyReplica(snapshot.board);
      // A copy missing messages the host still holds asks for everything next time.
      const seq = missing > 0 ? 0 : snapshot.seq;
      await writeJsonFile(hostStatePath(id), { version: 1, seq } satisfies HostState);
      this.seqs.set(id, seq);
      await this.markSynced(id);
      this.emit({ groupProjectId: id, seq: snapshot.seq, part: 'record' });
      // Each post that arrived is announced as the host's change, so this computer tells its own
      // members (#3362). Not on a first copy: its history isn't news.
      const arrived = previous > 0
        ? [...new Set(snapshot.board.messages.map((m) => m.seq ?? 0).filter((n) => n > previous))].sort((x, y) => x - y)
        : [];
      for (const seqArrived of arrived) this.emit({ groupProjectId: id, seq: seqArrived, part: 'board' });
      if (arrived.length === 0) this.emit({ groupProjectId: id, seq: snapshot.seq, part: 'board' });
    });
  }

  /** Drop this computer's copy: deleted on the host, or no longer shared. Writes waiting for it are refused. */
  private purgeReplica(id: string, reason: string): Promise<void> {
    return this.run(id, async () => {
      const project = await groupProjectRegistry.get(id);
      if (!project || !this.isReplica(project)) return;
      const last = await this.view(project);
      const waiting = (await this.loadOutbox()).filter((i) => i.groupProjectId === id);
      await this.removeFromOutbox(new Set(waiting.map((i) => i.id)));
      for (const item of waiting) await this.recordRefusal(item, reason);
      await groupProjectRegistry.delete(id);
      await groupProjectRegistry.flush();
      this.seqs.delete(id);
      await destroyBulletinBoard(id);
      appLog('core:group-project', 'info', 'Removed a copy of a network group project', { meta: { id, reason } });
      this.emit({ groupProjectId: id, seq: last.seq ?? 0, part: 'deleted', project: last });
    });
  }

  /**
   * A computer left the network (#3363). Its group projects become read-only
   * copies here, and writes waiting for it are refused; its agents leave this
   * computer's network group projects.
   */
  async machineRemoved(machine: string): Promise<void> {
    const fp = machine.toLowerCase();
    for (const project of await groupProjectRegistry.list()) {
      if (this.isReplica(project) && project.host?.machine === fp) {
        const state = await this.replicaState(project.id).catch((): ReplicaState => ({ version: 1 }));
        await writeJsonFile(replicaStatePath(project.id), { ...state, hostRemoved: true } satisfies ReplicaState);
        const waiting = (await this.loadOutbox()).filter((i) => i.groupProjectId === project.id);
        await this.removeFromOutbox(new Set(waiting.map((i) => i.id)));
        for (const item of waiting) await this.recordRefusal(item, `${this.hostNameOf(project)} left your network.`);
      } else if (!this.isReplica(project) && project.scope?.reach === 'network') {
        await this.updateMembership(project.id, (draft) => {
          draft.explicit = draft.explicit.filter((e) => parseAgentAddress(e.address).machine !== fp);
        });
        for (const b of bindingManager.getAllBindings()) {
          if (b.targetKind === 'group-project' && b.targetId === project.id && parseAgentAddress(b.agentId).machine === fp) bindingManager.unbind(b.agentId, project.id);
        }
      }
    }
    groupProjectRegistry.touch();
  }

  // ── The host side ──

  /** What a network computer asked to catch up on: the network group projects hosted here. */
  async networkSnapshot(request: SyncRequest): Promise<SyncResponse> {
    await this.reconcile();
    const self = this.selfMachine();
    if (!self) return { v: 1, projects: [], unchanged: [], tombstones: [] };
    const projects: ReplicaSnapshot[] = [];
    const unchanged: string[] = [];
    for (const project of await groupProjectRegistry.list()) {
      if (this.isReplica(project) || project.scope?.reach !== 'network') continue;
      const snapshot = await this.run(project.id, async (): Promise<ReplicaSnapshot | null> => {
        const seq = await this.seqOf(project.id);
        const known = request.known[project.id];
        if (known === seq) return null;
        const since = known !== undefined && known < seq ? known : 0;
        const membership = await readMembershipFile(project.id, self);
        const board = await getBulletinBoard(project.id).replicaSince(since);
        const view = await this.view(project);
        const { network: _network, hostName: _hostName, ...record } = view;
        return {
          record: { ...record, host: { machine: self }, seq, ...(await this.scopeProjectKeyOf(project)) },
          seq, membership, board,
        };
      });
      if (snapshot) projects.push(snapshot);
      else unchanged.push(project.id);
    }
    const tombstones = (await this.loadTombstones())
      .filter((t) => t.host.machine === null || t.host.machine === self)
      .map((t) => ({ ...t, host: { machine: self } }));
    return { v: 1, projects, unchanged, tombstones };
  }

  private async scopeProjectKeyOf(project: GroupProject): Promise<{ scopeProjectKey?: string }> {
    if (project.scope?.level !== 'project') return {};
    const scoped = (await projectStore.list()).find((p) => p.id === (project.scope as { projectId: string }).projectId);
    if (!scoped) return {};
    try {
      return { scopeProjectKey: await agentConfig.projectKey(scoped.path) };
    } catch {
      // telemetry-exempt: without a key, other computers' projects aren't matched to it
      return {};
    }
  }

  /** Writes from another computer in the network, applied or refused here in order. */
  applyRemoteWrites(machine: string, request: WriteRequest): Promise<WriteResponse> {
    const sender = machine.toLowerCase();
    return this.serial(this.senderChains, sender, async () => {
      const results: WriteResult[] = [];
      for (const item of request.writes) results.push(await this.applyRemoteWriteOnce(sender, item));
      return { v: 1, results };
    });
  }

  private async loadApplied(): Promise<AppliedWrite[]> {
    if (!this.appliedWrites) {
      this.appliedWrites = (await readJsonFile(networkAppliedPath(), (): StoredList<AppliedWrite> => ({ version: 1, items: [] }), validateStoredList<AppliedWrite>)).items;
    }
    return this.appliedWrites;
  }

  /**
   * Each write is answered once: its answer is saved, and a write sent again
   * (its response was lost) gets the same answer. A post made before a crash
   * that lost its answer is found by its message id, made from the write's.
   */
  private async applyRemoteWriteOnce(machine: string, item: QueuedWrite): Promise<WriteResult> {
    const earlier = (await this.loadApplied()).find((a) => a.machine === machine && a.id === item.id);
    if (earlier) return earlier.result;
    const result = await this.applyRemoteWrite(machine, item);
    if (result.status === 'applied') {
      // Durable before it's answered: a failed flush answers nothing, saves no receipt, and the
      // sender sends the write again with the same id.
      await groupProjectRegistry.flush();
      await getBulletinBoard(item.groupProjectId).flush();
    }
    await this.serial(this.fileChains, 'applied', async () => {
      const now = Date.now();
      const items = [...(await this.loadApplied()).filter((a) => now - Date.parse(a.at) < APPLIED_TTL_MS), { machine, id: item.id, result, at: new Date(now).toISOString() }]
        .slice(-APPLIED_MAX);
      await writeJsonFile(networkAppliedPath(), { version: 1, items } satisfies StoredList<AppliedWrite>);
      this.appliedWrites = items;
    });
    return result;
  }

  /**
   * Who may make a remote write (#3363, fails closed). An agent on the sending
   * computer must be a member; anything beyond posting is the grants' to allow
   * (#3360 registers the gate), and without a gate only posting is. The person
   * may (their computers already control each other). A computer's own
   * housekeeping (channels, its agents' inboxes, its agents' membership
   * entries, its agents' join and leave notes) covers only its own agents.
   */
  private async authorizeRemote(project: GroupProject, machine: string, item: QueuedWrite): Promise<string | undefined> {
    const { author, write } = item;
    if (author.agentId) {
      const address = memberAddress(parseAgentAddress(author.agentId).agentId, machine, this.hostMachineOf(project));
      const [members, membership] = await Promise.all([this.resolveMembers(project.id), this.getMembership(project.id)]);
      const isMember = members.some((m) => m.address === address) || membership.explicit.some((e) => e.address === address);
      const action = REMOTE_ACTION[write.op];
      if (this.remoteWriteGate) return this.remoteWriteGate({ project, machine, write: item, address, isMember, action });
      if (!isMember) return 'Only a member of this group project can do that.';
      if (action !== 'group_project.post') return 'This change needs a lead or admin grant on its host.';
      return undefined;
    }
    if (isPersonAuthor(author)) return undefined;
    switch (write.op) {
      case 'ensureChannels':
      case 'ensureInbox':
      case 'membership':
        return undefined;
      case 'post':
        if (write.sender === 'system' && normalizeChannelName(write.topic) === 'system') return undefined;
        return 'A post from another computer needs an author.';
      default:
        return 'A change from another computer needs an author.';
    }
  }

  private async applyRemoteWrite(machine: string, item: QueuedWrite): Promise<WriteResult> {
    const refuse = (reason: string): WriteResult => ({ id: item.id, status: 'refused', reason });
    const id = item.groupProjectId;
    if ((await this.loadTombstones()).some((t) => t.groupProjectId === id)) return refuse('This group project was deleted.');
    const project = await groupProjectRegistry.get(id);
    if (!project) return refuse('This group project no longer exists.');
    if (this.isReplica(project)) return refuse('This computer is not its host.');
    if (project.scope?.reach !== 'network') return refuse('This group project is no longer shared with your network.');
    const denied = await this.authorizeRemote(project, machine, item).catch((err: unknown) => `Not allowed: ${err instanceof Error ? err.message : String(err)}`);
    if (denied) return refuse(denied);
    const write = item.write;
    const system = !item.author.agentId && !isPersonAuthor(item.author);
    try {
      let result: unknown;
      switch (write.op) {
        case 'post': {
          const topic = normalizeChannelName(write.topic);
          if (topic === 'system' && !(system && write.sender === 'system')) return refuse('The system channel is reserved.');
          // The same write always makes the same message, so a replay after a crash finds it.
          const messageId = `msg_${Date.parse(item.queuedAt) || 0}_${createHash('sha256').update(`${machine}\u0000${item.id}`).digest('hex').slice(0, 12)}`;
          result = await this.post(id, write.sender, write.topic, write.body, { messageId });
          break;
        }
        case 'deleteMessage':
          result = await this.deleteMessage(id, write.topic, write.messageId);
          break;
        case 'deleteTopic':
          if (normalizeChannelName(write.topic) === 'system') return refuse('The system channel can\'t be deleted.');
          result = await this.deleteTopic(id, write.topic);
          break;
        case 'setTopicProtected':
          await this.setTopicProtected(id, write.topic, write.isProtected);
          break;
        case 'update':
          await this.update(id, write.fields);
          break;
        case 'membership':
          await this.updateMembership(id, (draft) => applyMembershipPatch(draft, system ? patchForMachine(write.patch, machine, draft) : write.patch));
          break;
        case 'ensureChannels':
          await this.ensureChannels(id);
          break;
        case 'ensureInbox': {
          // A computer speaks for its own agents only.
          const address = canonicalMemberAddress(write.address, this.hostMachineOf(project));
          if (parseAgentAddress(address).machine !== machine) return refuse('An inbox can only be claimed for an agent on the computer asking.');
          result = await this.ensureInbox(id, write.agentName, address);
          break;
        }
      }
      return { id: item.id, status: 'applied', seq: await this.seqOf(id), ...(result !== undefined && { result }) };
    } catch (err) {
      // telemetry-exempt: answered to the sending computer, which shows it to the author
      return refuse(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  flushRegistry(): Promise<void> {
    return groupProjectRegistry.flush();
  }

  flushBoards(): Promise<void> {
    return flushAllBulletinBoards();
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** For testing: forget cached state (files are untouched). */
  _resetForTesting(): void {
    this.queues.clear();
    this.seqs.clear();
    this.tombstones = null;
    this.reconciled = null;
    this.listeners.clear();
    this.memberResolver = null;
    this.link = null;
    this.remoteWriteGate = null;
    this.outbox = null;
    this.refusals = null;
    this.hostChains.clear();
    this.syncChains.clear();
    this.fileChains.clear();
    this.senderChains.clear();
    this.replicaTombstones = null;
    this.appliedWrites = null;
  }
}

export const groupProjectHost = new GroupProjectHostService();
