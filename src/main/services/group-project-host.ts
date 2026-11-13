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
  GroupProjectMemberView, GroupProjectMembership, GroupProjectTombstone, TopicDigest,
} from '../../shared/group-project-types';
import { canonicalMemberAddress, memberAddress } from '../../shared/group-project-members';
import { groupProjectRegistry } from './group-project-registry';
import {
  PROJECT_CHANNELS, destroyBulletinBoard, ensureInboxChannel, ensureProjectChannels, flushAllBulletinBoards,
  getBulletinBoard, normalizeChannelName, resolveInboxChannel,
} from './group-project-bulletin';
import { readMembershipFile, validateMembership, writeMembershipFile } from './group-project-membership-file';
import * as fs from 'fs';
import { assertGroupProjectId, groupProjectDir, hostStatePath, tombstonesPath } from './group-project-paths';
import { readJsonFile, writeJsonFile } from './group-project-json-file';
import * as annexIdentity from './annex-identity';
import { annexEphemeralSession } from './annex-network-profile';
import { appLog } from './log-service';

export type GroupProjectHostErrorCode = 'not_found' | 'changed' | 'invalid';

export class GroupProjectHostError extends Error {
  constructor(readonly code: GroupProjectHostErrorCode, message: string) {
    super(message);
    this.name = 'GroupProjectHostError';
  }
}

/** Who is a member now; #3357 registers its policy, otherwise wires decide. */
export type GroupProjectMemberResolver = (project: GroupProject, membership: GroupProjectMembership) => Promise<GroupProjectMemberView[]>;

type ChangeListener = (change: GroupProjectChange) => void;

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
      || (t.host.machine !== null && typeof t.host.machine !== 'string')) {
      throw new Error('Group project tombstones contain an invalid entry.');
    }
    return { groupProjectId: t.groupProjectId, host: { machine: t.host.machine }, seq: t.seq, deletedAt: t.deletedAt };
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

  /** Whether a host is this machine. Null is the machine whose registry holds the record. */
  isThisMachine(host: GroupProjectHost | undefined): boolean {
    const machine = host?.machine ?? null;
    return machine === null || machine === this.selfMachine();
  }

  // ── Serialization and sequence numbers ──────────────────────────────────

  private run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const step = (): Promise<T> => fn();
    const next: Promise<T> = previous.then(step, step);
    const settle = (): void => undefined;
    const tail: Promise<void> = next.then(settle, settle);
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
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

  /** A delete interrupted after its tombstone was saved is finished on the next start. */
  private reconcile(): Promise<void> {
    if (!this.reconciled) {
      this.reconciled = (async () => {
        const tombstones = await this.loadTombstones();
        for (const tombstone of tombstones) {
          if (await groupProjectRegistry.get(tombstone.groupProjectId)) {
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

  // ── Records ──────────────────────────────────────────────────────────────

  private async view(project: GroupProject): Promise<GroupProject> {
    return { ...project, host: { machine: project.host?.machine ?? null }, seq: await this.seqOf(project.id) };
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
    const created = await groupProjectRegistry.create(name, options, { machine: this.selfMachine() }, undefined, (id) => !tombstoned.has(id));
    await this.commit(created.id, 'record', async ({ reserve }) => {
      const seq = await reserve();
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

  async update(id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }): Promise<GroupProject | null> {
    try {
      return await this.commit(id, 'record', async ({ reserve }) => {
        await reserve();
        const updated = await groupProjectRegistry.update(id, fields);
        return updated && this.view(updated);
      });
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
      return fn({ project, seq: project.seq ?? 0 });
    });
  }

  /**
   * Delete a group project: record, board, membership and sequence state, leaving
   * a tombstone first so a crash part way through is finished on the next start.
   * With `expectedSeq`, refuses (`changed`) if anything changed since.
   */
  async delete(id: string, options: { expectedSeq?: number; withinExclusive?: boolean } = {}): Promise<{ deleted: boolean; tombstone?: GroupProjectTombstone }> {
    assertGroupProjectId(id);
    const body = async () => {
      await this.reconcile();
      const project = await groupProjectRegistry.get(id);
      if (!project) return { deleted: false };
      const current = await this.seqOf(id);
      if (options.expectedSeq !== undefined && options.expectedSeq !== current) {
        throw new GroupProjectHostError('changed', 'The group project changed after its impact was shown. Review it again before deleting.');
      }
      const seq = current + 1;
      const tombstone: GroupProjectTombstone = {
        groupProjectId: id, host: { machine: project.host?.machine ?? null }, seq, deletedAt: new Date().toISOString(),
      };
      const now = Date.now();
      const kept = (await this.loadTombstones())
        .filter((t) => t.groupProjectId !== id)
        // Past its age or count, a tombstone stays while its data still waits to be removed.
        .filter((t, i, all) => fs.existsSync(groupProjectDir(t.groupProjectId))
          || (now - Date.parse(t.deletedAt) < TOMBSTONE_TTL_MS && i >= all.length - (TOMBSTONE_MAX - 1)));
      await writeJsonFile(tombstonesPath(), [...kept, tombstone]);
      this.tombstones = [...kept, tombstone];
      await groupProjectRegistry.delete(id);
      await groupProjectRegistry.flush();
      this.seqs.delete(id);
      // A failure here rejects; the tombstone stays and the next start removes the data.
      await destroyBulletinBoard(id, { strict: true });
      this.emit({ groupProjectId: id, seq, part: 'deleted' });
      return { deleted: true, tombstone: { ...tombstone, host: { ...tombstone.host } } };
    };
    return options.withinExclusive ? body() : this.run(id, body);
  }

  // ── Membership ───────────────────────────────────────────────────────────

  async getMembership(id: string): Promise<GroupProjectMembership> {
    const project = await this.requireProject(id);
    return readMembershipFile(id, project.host?.machine ?? null);
  }

  /** Change the membership record. `fn` edits a copy; a throw changes nothing. */
  updateMembership(id: string, fn: (draft: GroupProjectMembership) => GroupProjectMembership | void): Promise<{ membership: GroupProjectMembership; seq: number }> {
    return this.commit(id, 'membership', async ({ project, reserve }) => {
      const hostMachine = project.host?.machine ?? null;
      const current = await readMembershipFile(id, hostMachine);
      const draft = structuredClone(current);
      const next = validateMembership(fn(draft) ?? draft, hostMachine);
      if (sameJson(current, next)) return { membership: current, seq: await this.seqOf(id) };
      const seq = await reserve();
      await writeMembershipFile(id, next);
      return { membership: next, seq };
    });
  }

  /** #3357 registers who is a member; until then, wires decide. */
  setMemberResolver(resolver: GroupProjectMemberResolver | null): void {
    this.memberResolver = resolver;
  }

  async resolveMembers(id: string): Promise<GroupProjectMemberView[]> {
    const project = await this.requireProject(id);
    if (this.memberResolver) return this.memberResolver(await this.view(project), await this.getMembership(id));
    const { bindingManager } = await import('./clubhouse-mcp/binding-manager');
    const seen = new Set<string>();
    const members: GroupProjectMemberView[] = [];
    for (const b of bindingManager.getAllBindings()) {
      if (b.targetKind !== 'group-project' || b.targetId !== id) continue;
      const address = canonicalMemberAddress(b.agentId, project.host?.machine ?? null);
      if (seen.has(address)) continue;
      seen.add(address);
      members.push({ address, name: b.agentName || b.agentId });
    }
    return members;
  }

  /** The host-relative address of an agent here or on another machine. */
  memberAddress(project: GroupProject, agentId: string, machine?: string | null): string {
    return memberAddress(agentId, machine ?? this.selfMachine(), project.host?.machine ?? this.selfMachine());
  }

  // ── Board ────────────────────────────────────────────────────────────────

  post(id: string, sender: string, topic: string, body: string): Promise<BulletinMessage> {
    return this.commit(id, 'board', async ({ reserve }) => getBulletinBoard(id).postMessage(sender, topic, body, await reserve()));
  }

  /** False when there's no such message, or no such group project, as before #3356. */
  deleteMessage(id: string, topic: string, messageId: string): Promise<boolean> {
    return this.unlessMissing(false, () => this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      const message = await board.getMessageById(messageId);
      if (!message || message.topic !== normalizeChannelName(topic)) return false;
      await reserve();
      return board.deleteMessage(topic, messageId);
    }));
  }

  deleteTopic(id: string, topic: string): Promise<boolean> {
    return this.unlessMissing(false, () => this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      if (!(await board.hasTopic(topic))) return false;
      await reserve();
      return board.deleteTopic(topic);
    }));
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

  setTopicProtected(id: string, topic: string, isProtected: boolean): Promise<void> {
    return this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      await board.hasTopic(topic);
      if (board.isTopicProtected(topic) === isProtected) return;
      await reserve();
      board.setTopicProtected(topic, isProtected);
    });
  }

  clearAll(id: string): Promise<number> {
    return this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      await board.hasTopic('general');
      if (board.totalMessageCount() === 0) return 0;
      await reserve();
      return board.clearAll();
    });
  }

  /** Save retention limits and trim the board to them, as one change. */
  setRetention(id: string, maxPerTopic: number, maxTotal: number): Promise<number> {
    return this.commit(id, 'record', async ({ reserve }) => {
      await reserve();
      await groupProjectRegistry.update(id, { metadata: { maxPerTopic, maxTotal } });
      const board = getBulletinBoard(id);
      board.setLimits(maxPerTopic, maxTotal);
      return board.trimToLimits();
    });
  }

  /** Seed `general` and `control` and keep them protected. Changes nothing when they are. */
  ensureChannels(id: string): Promise<void> {
    return this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      let ready = true;
      for (const name of PROJECT_CHANNELS) {
        if (!(await board.hasTopic(name)) || !board.isTopicProtected(name)) ready = false;
      }
      if (ready) return;
      await ensureProjectChannels(id, await reserve());
    });
  }

  /** Seed a member's inbox, kept apart from any other member with the same name (#1646). Returns its channel. */
  ensureInbox(id: string, agentName: string, address: string): Promise<string> {
    return this.commit(id, 'board', async ({ project, reserve }) => {
      const canonical = canonicalMemberAddress(address, project.host?.machine ?? null);
      const board = getBulletinBoard(id);
      const channel = await resolveInboxChannel(id, agentName, canonical);
      if ((await board.inboxOwner(channel)) === canonical && (await board.hasTopic(channel)) && board.isTopicProtected(channel)) return channel;
      return ensureInboxChannel(id, agentName, canonical, await reserve());
    });
  }

  /** The board's topics, counts and protection, without changing anything. Safe inside `exclusive`. */
  async digest(id: string): Promise<TopicDigest[]> {
    await this.requireProject(id);
    return getBulletinBoard(id).getDigest();
  }

  /** The inbox channel of a member, without changing anything. */
  async inboxFor(id: string, agentName: string, address?: string): Promise<string> {
    const project = await this.requireProject(id);
    return resolveInboxChannel(id, agentName, address && canonicalMemberAddress(address, project.host?.machine ?? null));
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
  }
}

export const groupProjectHost = new GroupProjectHostService();
