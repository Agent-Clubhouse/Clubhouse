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
  DigestSince, GroupProjectMemberView, GroupProjectMembership, GroupProjectScope, GroupProjectScopeOptions, GroupProjectTombstone, TopicDigest,
} from '../../shared/group-project-types';
import {
  GroupProjectScopeError, memberInScope, membersLeavingScope, resolveGroupProjectScope, sameGroupProjectScope,
} from '../../shared/group-project-scope';
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
import { networkEnabled } from './annex-settings';
import * as projectStore from './project-store';
import * as agentConfig from './agent-config';
import { agentRegistry } from './agent-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { annexEphemeralSession } from './annex-network-profile';
import { appLog } from './log-service';

export type GroupProjectHostErrorCode = 'not_found' | 'changed' | 'invalid' | 'network_unavailable';

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
    const network = this.scopeOptions().network;
    const created = await groupProjectRegistry.create(
      name, options, { machine: this.selfMachine() },
      (input, registered) => resolveGroupProjectScope(input, registered, network), (id) => !tombstoned.has(id),
    );
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

  async update(
    id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }, options: { withinExclusive?: boolean } = {},
  ): Promise<GroupProject | null> {
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
      return fn({ project, seq: project.seq ?? 0 });
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

  /** Run `fn` in a tombstoned group project's queue, after its record is hidden or gone (#3364 recovery). */
  exclusivePending<T>(id: string, fn: (tombstone: GroupProjectTombstone) => Promise<T>): Promise<T> {
    assertGroupProjectId(id);
    return this.run(id, async () => {
      const tombstone = await this.tombstoneOf(id);
      if (!tombstone) throw new GroupProjectHostError('not_found', `Group project ${id} has no delete in progress.`);
      return fn({ ...tombstone, host: { ...tombstone.host } });
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
      if (!(await groupProjectRegistry.get(id))) return { deleted: false };
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
  updateMembership(
    id: string, fn: (draft: GroupProjectMembership) => GroupProjectMembership | void, options: { withinExclusive?: boolean } = {},
  ): Promise<{ membership: GroupProjectMembership; seq: number }> {
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
      const address = canonicalMemberAddress(b.agentId, this.hostMachineOf(project));
      if (seen.has(address)) continue;
      seen.add(address);
      const projectId = projects.get(b.agentId);
      members.push({ address, name: b.agentName || b.agentId, ...(projectId && { projectId }) });
    }
    return members;
  }

  /** Each local agent's registered project: durable agents from their configs, others from their live registration. */
  private async agentProjects(): Promise<Map<string, string>> {
    const projects = await projectStore.list();
    const byAgent = new Map<string, string>();
    for (const project of projects) {
      let agents: readonly { id: string }[] = [];
      try {
        agents = await agentConfig.peekDurableConfigs(project.path);
      } catch (err) {
        // telemetry-exempt: logged; members of an unreadable project count as project unknown, never as leaving
        appLog('core:group-project', 'warn', 'Could not read agents for group project scope', {
          meta: { projectId: project.id, error: err instanceof Error ? err.message : String(err) },
        });
      }
      for (const agent of agents) byAgent.set(agent.id, project.id);
    }
    for (const [agentId, registration] of agentRegistry.getAllRegistrations()) {
      if (byAgent.has(agentId)) continue;
      const project = projects.find((p) => p.path === registration.projectPath);
      if (project) byAgent.set(agentId, project.id);
    }
    return byAgent;
  }

  // ── Scope (#3355) ────────────────────────────────────────────────────────

  /** Whether network reach can be chosen now, and why not. */
  scopeOptions(): GroupProjectScopeOptions {
    if (!networkEnabled()) {
      return { network: { available: false, reason: 'Network reach needs Annex Network. Turn it on in Settings > Annex Network.' } };
    }
    return { network: { available: false, reason: 'Network group projects are not available in this version yet.' } };
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
  async previewScope(id: string, scope: unknown): Promise<{ scope: GroupProjectScope; leaving: GroupProjectMemberView[] }> {
    const next = await this.resolveScope(scope);
    return { scope: next, leaving: membersLeavingScope(next, await this.resolveMembers(id)) };
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
    return this.commit(id, 'record', async ({ project, reserve }) => {
      if (project.scope && sameGroupProjectScope(project.scope, next)) return { project: await this.view(project), left: [] };
      const leaving = membersLeavingScope(next, await this.resolveMembers(id));
      const confirmed = new Set(options.confirmLeaving ?? []);
      if (leaving.length !== confirmed.size || leaving.some((member) => !confirmed.has(member.address))) {
        throw new GroupProjectHostError('changed', 'The members who would leave have changed. Review the scope change again.');
      }
      const seq = await reserve();
      const updated = await groupProjectRegistry.setScope(id, next);
      const hostMachine = this.hostMachineOf(project);
      const leavingAddresses = new Set(leaving.map((member) => member.address));
      if (leaving.length > 0) {
        const membership = await readMembershipFile(id, hostMachine);
        const explicit = membership.explicit.filter((entry) => !leavingAddresses.has(entry.address));
        if (explicit.length !== membership.explicit.length) await writeMembershipFile(id, { ...membership, explicit });
        for (const b of bindingManager.getAllBindings()) {
          if (b.targetKind === 'group-project' && b.targetId === id && leavingAddresses.has(canonicalMemberAddress(b.agentId, hostMachine))) {
            bindingManager.unbind(b.agentId, id);
          }
        }
      }
      appLog('core:group-project', 'info', 'Group project scope changed', { meta: { id, seq, scope: next, left: leaving.length } });
      return { project: await this.view(updated ?? project), left: leaving };
    }, options.withinExclusive);
  }

  /**
   * Whether an agent here may be a member under the group project's scope.
   * Unresolved scope, or an agent whose project isn't known, is admitted.
   */
  async admits(id: string, agentId: string): Promise<boolean> {
    const project = await groupProjectRegistry.get(id);
    if (!project?.scope) return true;
    const address = canonicalMemberAddress(agentId, this.hostMachineOf(project));
    const projectId = project.scope.level === 'project' ? (await this.agentProjects()).get(agentId) : undefined;
    return memberInScope(project.scope, { address, projectId }) !== false;
  }

  /** The host-relative address of an agent here or on another machine. */
  memberAddress(project: GroupProject, agentId: string, machine?: string | null): string {
    return memberAddress(agentId, machine ?? this.selfMachine(), this.hostMachineOf(project));
  }

  // ── Board ────────────────────────────────────────────────────────────────
  // Every write takes `withinExclusive` for use inside `exclusive()`.

  post(id: string, sender: string, topic: string, body: string, options: { withinExclusive?: boolean } = {}): Promise<BulletinMessage> {
    return this.commit(id, 'board', async ({ reserve }) => getBulletinBoard(id).postMessage(sender, topic, body, await reserve()), options.withinExclusive);
  }

  /** False when there's no such message, or no such group project, as before #3356. */
  deleteMessage(id: string, topic: string, messageId: string, options: { withinExclusive?: boolean } = {}): Promise<boolean> {
    return this.unlessMissing(false, () => this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      const message = await board.getMessageById(messageId);
      if (!message || message.topic !== normalizeChannelName(topic)) return false;
      await reserve();
      return board.deleteMessage(topic, messageId);
    }, options.withinExclusive));
  }

  deleteTopic(id: string, topic: string, options: { withinExclusive?: boolean } = {}): Promise<boolean> {
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

  setTopicProtected(id: string, topic: string, isProtected: boolean, options: { withinExclusive?: boolean } = {}): Promise<void> {
    return this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      await board.hasTopic(topic);
      if (board.isTopicProtected(topic) === isProtected) return;
      await reserve();
      board.setTopicProtected(topic, isProtected);
    }, options.withinExclusive);
  }

  clearAll(id: string, options: { withinExclusive?: boolean } = {}): Promise<number> {
    return this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      await board.hasTopic('general');
      if (board.totalMessageCount() === 0) return 0;
      await reserve();
      return board.clearAll();
    }, options.withinExclusive);
  }

  /** Save retention limits and trim the board to them, as one change. Unchanged limits that trim nothing take no number. */
  setRetention(id: string, maxPerTopic: number, maxTotal: number, options: { withinExclusive?: boolean } = {}): Promise<number> {
    return this.commit(id, 'record', async ({ project, reserve }) => {
      const board = getBulletinBoard(id);
      await board.hasTopic('general');
      board.setLimits(maxPerTopic, maxTotal);
      const saved = project.metadata.maxPerTopic === maxPerTopic && project.metadata.maxTotal === maxTotal;
      if (saved && board.estimateTrimCount(maxPerTopic, maxTotal) === 0) return 0;
      await reserve();
      if (!saved) await groupProjectRegistry.update(id, { metadata: { maxPerTopic, maxTotal } });
      return board.trimToLimits();
    }, options.withinExclusive);
  }

  /** Seed `general` and `control` and keep them protected. Changes nothing when they are. */
  ensureChannels(id: string, options: { withinExclusive?: boolean } = {}): Promise<void> {
    return this.commit(id, 'board', async ({ reserve }) => {
      const board = getBulletinBoard(id);
      let ready = true;
      for (const name of PROJECT_CHANNELS) {
        if (!(await board.hasTopic(name)) || !board.isTopicProtected(name)) ready = false;
      }
      if (ready) return;
      await ensureProjectChannels(id, await reserve());
    }, options.withinExclusive);
  }

  /** Seed a member's inbox, kept apart from any other member with the same name (#1646). Returns its channel. */
  ensureInbox(id: string, agentName: string, address: string, options: { withinExclusive?: boolean } = {}): Promise<string> {
    return this.commit(id, 'board', async ({ project, reserve }) => {
      const canonical = canonicalMemberAddress(address, this.hostMachineOf(project));
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
    return resolveInboxChannel(id, agentName, address && canonicalMemberAddress(address, this.hostMachineOf(project)));
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
