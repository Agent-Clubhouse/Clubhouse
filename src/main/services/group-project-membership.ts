/**
 * Group project membership (#3357): who is in a group project, as a record
 * on its host rather than canvas wires. MCP bindings are derived from it.
 *
 * - **Auto-join.** With `autoJoin`, every top-level durable agent in the group
 *   project's scope is a member, existing and future. One that leaves scope
 *   (moved, deleted, its project removed) leaves.
 * - **Exclusions.** An excluded agent never joins automatically, across
 *   restarts. Including it again removes the exclusion.
 * - **Helpers** join only when added, and leave when disposed.
 * - **Quick agents** join only when added, for one run. Their entry goes when
 *   the run ends; their posts stay. Their display name carries a suffix from
 *   their id, so two runs drawing the same name get separate inboxes (#1646).
 * - **Migration.** A group project from before this record keeps exactly the
 *   members its wires gave it, with auto-join off, and the directory offers
 *   "Include every agent in scope" once. A new group project auto-joins.
 *
 * The record is a pruning binding source ({@link membershipBindingSource}):
 * restores are silent, and canvas cleanup (a card or canvas closing) keeps a
 * binding the record holds. Changes after startup bind and unbind through
 * claim/release, so a new member's join is announced on the board.
 *
 * Canvas gestures map onto the record in the binding IPC: drawing a wire to a
 * managed group project adds a member (or removes an exclusion), deleting the
 * wire excludes, and re-binding a stored wire never adds anyone.
 */

import type {
  AutoJoinPreview, GroupProject, GroupProjectScope, GroupProjectMemberKind, GroupProjectMembership, GroupProjectMembershipView, GroupProjectMemberView, ResolvedGroupProjectMember,
} from '../../shared/group-project-types';
import { groupProjectHost } from './group-project-host';
import * as projectStore from './project-store';
import { listDurable, onAgentConfigChanged } from './agent-config';
import { knownQuickAgents } from './quick-agent-events';
import { onAppEvent } from './app-event-bus';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  claimSourceBinding, clearBindingRemovedByUser, releaseSourceBinding,
  type CollectedBindings, type PersistedBinding, type PersistedBindingSource,
} from './persisted-bindings';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { resolveGroupProjectScope } from '../../shared/group-project-scope';
import { canvasWireBindingSource } from './canvas-wire-source';
import { readAllCanvasStores } from './canvas-store-reader';
import { appLog } from './log-service';

export const GROUP_PROJECT_MEMBERSHIP_SOURCE_ID = 'group-project-membership';

/** When this process started: a group project created since has no legacy wires to keep. */
const startedAt = Date.now();

// ── Inventory ───────────────────────────────────────────────────────────────

interface AgentFact {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  helper: boolean;
  disposed: boolean;
}

interface Inventory {
  agents: Map<string, AgentFact>;
  /** Projects whose agents couldn't be read: their members are unknown this time. */
  unreadable: Set<string>;
}

async function readInventory(): Promise<Inventory> {
  const agents = new Map<string, AgentFact>();
  const unreadable = new Set<string>();
  for (const project of await projectStore.list()) {
    try {
      for (const agent of await listDurable(project.path)) {
        agents.set(agent.id, {
          id: agent.id,
          name: agent.name,
          projectId: project.id,
          projectName: project.displayName || project.name,
          helper: !!agent.parentAgentId,
          disposed: isDisposedAgent(agent),
        });
      }
    } catch (err) {
      // telemetry-exempt: an unreadable project leaves its members as they are; logged for diagnosis
      unreadable.add(project.id);
      appLog('core:group-project', 'warn', 'Group project membership could not read a project\'s agents', {
        meta: { projectId: project.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return { agents, unreadable };
}

interface QuickFact { id: string; name: string; projectId?: string; projectName?: string; runId: string }

async function liveQuickAgents(): Promise<Map<string, QuickFact>> {
  const projects = await projectStore.list();
  const out = new Map<string, QuickFact>();
  for (const [id, run] of knownQuickAgents()) {
    if (run.finishedAt !== undefined) continue;
    const project = projects.find((p) => p.path === run.projectPath);
    out.set(id, {
      id, name: run.name, runId: quickRunId(id, run.startedAt),
      ...(project && { projectId: project.id, projectName: project.displayName || project.name }),
    });
  }
  return out;
}

function quickRunId(agentId: string, startedAtMs: number): string {
  return `${agentId}:${startedAtMs}`;
}

/** A quick agent's member name: its name and a suffix from its id, unique per run (#1646). */
export function quickMemberName(name: string, agentId: string): string {
  const suffix = agentId.replace(/[^A-Za-z0-9]/g, '').slice(-4).toLowerCase();
  return suffix ? `${name}-${suffix}` : name;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** A record the membership owns. A missing file reads as unmanaged: its group project still uses wires. */
export function isManagedMembership(m: GroupProjectMembership): boolean {
  return m.autoJoin || m.autoJoinOffer !== undefined;
}

function inScope(gp: GroupProject, agent: AgentFact): boolean {
  if (!gp.scope) return false;
  return gp.scope.level === 'app' || agent.projectId === gp.scope.projectId;
}

/** Top-level durable agents in scope, whether or not they're members. */
function autoCandidates(gp: GroupProject, inventory: Inventory): AgentFact[] {
  return [...inventory.agents.values()].filter((a) => !a.helper && !a.disposed && inScope(gp, a));
}

interface Resolution {
  members: ResolvedGroupProjectMember[];
  /** Agents whose membership can't be decided now: their bindings stay as they are. */
  unverified: string[];
}

/**
 * A cached copy of a group project hosted on another machine (#3363). Its
 * addresses are relative to the host, and the host decides who joins: here
 * only this machine's own agents the record lists are bound, and nothing is
 * written from what this machine sees.
 */
function isReplica(gp: GroupProject): boolean {
  return !groupProjectHost.isThisMachine(gp.host);
}

/** On a replica: the record's members that are agents on this machine, by local id. */
function resolveReplica(gp: GroupProject, m: GroupProjectMembership, inventory: Inventory): Resolution {
  const local = (address: string) => groupProjectHost.localAgentId(gp, address);
  const excluded = new Set(m.excluded.map((e) => local(e.address)).filter((id): id is string => !!id));
  const members = new Map<string, ResolvedGroupProjectMember>();
  const unverified: string[] = [];
  for (const entry of m.explicit) {
    const id = local(entry.address);
    if (!id || excluded.has(id) || members.has(id) || entry.kind === 'quick') continue;
    const agent = inventory.agents.get(id);
    if (!agent) {
      if (inventory.unreadable.size > 0) unverified.push(id);
      continue;
    }
    if (agent.disposed) continue;
    members.set(id, { agentId: id, name: agent.name, kind: agent.helper ? 'helper' : 'durable', via: 'explicit', projectId: agent.projectId, projectName: agent.projectName });
  }
  return { members: [...members.values()], unverified };
}

export function resolveMembership(
  gp: GroupProject, m: GroupProjectMembership, inventory: Inventory, quick: ReadonlyMap<string, QuickFact>,
): Resolution {
  if (isReplica(gp)) return resolveReplica(gp, m, inventory);
  const excluded = new Set(m.excluded.map((e) => e.address));
  const members = new Map<string, ResolvedGroupProjectMember>();
  const unverified: string[] = [];
  if (m.autoJoin) {
    for (const agent of autoCandidates(gp, inventory)) {
      if (excluded.has(agent.id)) continue;
      members.set(agent.id, { agentId: agent.id, name: agent.name, kind: 'durable', via: 'auto', projectId: agent.projectId, projectName: agent.projectName });
    }
    // Agents in a project that couldn't be read may be members: keep what they have.
    const scopeUnreadable = gp.scope?.level === 'app' ? inventory.unreadable.size > 0
      : !!gp.scope && inventory.unreadable.has(gp.scope.projectId);
    if (scopeUnreadable) {
      for (const b of bindingManager.getAllBindings()) {
        if (b.targetKind === 'group-project' && b.targetId === gp.id && !inventory.agents.has(b.agentId) && !excluded.has(b.agentId)) unverified.push(b.agentId);
      }
    }
  }
  for (const entry of m.explicit) {
    if (excluded.has(entry.address) || members.has(entry.address)) continue;
    if (entry.kind === 'quick') {
      const run = quick.get(entry.address);
      if (!run || (entry.runId && entry.runId !== run.runId)) continue;
      members.set(run.id, {
        agentId: run.id, name: quickMemberName(run.name, run.id), kind: 'quick', via: 'explicit',
        ...(run.projectId && { projectId: run.projectId, projectName: run.projectName }),
      });
      continue;
    }
    const agent = inventory.agents.get(entry.address);
    if (!agent) {
      if (inventory.unreadable.size > 0) unverified.push(entry.address);
      continue;
    }
    if (agent.disposed) continue;
    members.set(agent.id, {
      agentId: agent.id, name: agent.name, kind: agent.helper ? 'helper' : 'durable', via: 'explicit',
      projectId: agent.projectId, projectName: agent.projectName,
    });
  }
  return { members: [...members.values()], unverified };
}

function memberBinding(gp: GroupProject, m: GroupProjectMembership, member: ResolvedGroupProjectMember): PersistedBinding {
  const own = m.disabledTools?.[member.agentId];
  const fallback = gp.metadata?.defaultDisabledTools;
  const disabledTools = Array.isArray(own) ? own
    : Array.isArray(fallback) && fallback.every((t) => typeof t === 'string') ? fallback as string[] : undefined;
  const instructions = m.instructions?.[member.agentId];
  return {
    agentId: member.agentId,
    targetId: gp.id,
    targetKind: 'group-project',
    label: gp.name,
    agentName: member.name,
    targetName: gp.name,
    projectName: gp.name,
    ...(disabledTools && disabledTools.length > 0 && { disabledTools: [...disabledTools] }),
    ...(instructions && Object.keys(instructions).length > 0 && { instructions: { ...instructions } }),
  };
}

// ── State ───────────────────────────────────────────────────────────────────

interface Snapshot {
  gp: GroupProject;
  membership: GroupProjectMembership;
  resolution: Resolution;
}

async function snapshotAll(): Promise<{ snapshots: Snapshot[]; inventory: Inventory; quick: Map<string, QuickFact> }> {
  const [projects, inventory, quick] = await Promise.all([groupProjectHost.list(), readInventory(), liveQuickAgents()]);
  const snapshots: Snapshot[] = [];
  for (const gp of projects) {
    const membership = await groupProjectHost.getMembership(gp.id);
    if (!isManagedMembership(membership)) continue;
    snapshots.push({ gp, membership, resolution: resolveMembership(gp, membership, inventory, quick) });
  }
  return { snapshots, inventory, quick };
}

/** Group project id → member agent ids, as last bound or released here. Null until the first rebuild. */
let listed: Map<string, Set<string>> | null = null;
let migrated = false;
const listeners = new Set<(groupProjectId: string) => void>();

/** Called when a group project's members or exclusions change. Returns the unsubscribe. */
export function onMembershipChanged(listener: (groupProjectId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(groupProjectId: string): void {
  for (const fn of [...listeners]) {
    try { fn(groupProjectId); } catch (err) {
      // telemetry-exempt: one listener failing must not stop the others; logged
      appLog('core:group-project', 'warn', 'Membership listener failed', { meta: { groupProjectId, error: err instanceof Error ? err.message : String(err) } });
    }
  }
}

/** Whether a group project's members come from its record (not canvas wires). */
export async function isMembershipManaged(groupProjectId: string): Promise<boolean> {
  try {
    return isManagedMembership(await groupProjectHost.getMembership(groupProjectId));
  } catch (err) {
    // telemetry-exempt: an unreadable record is treated as unmanaged, so its wires keep working; logged
    appLog('core:group-project', 'warn', 'Group project membership could not be read', { meta: { groupProjectId, error: err instanceof Error ? err.message : String(err) } });
    return false;
  }
}

/** Ids of every group project whose members come from its record. */
export async function managedGroupProjectIds(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const gp of await groupProjectHost.list()) if (await isMembershipManaged(gp.id)) out.add(gp.id);
  return out;
}

/** The record's members as bindings, for every rebuild. Restores are silent. */
export const membershipBindingSource: PersistedBindingSource = {
  id: GROUP_PROJECT_MEMBERSHIP_SOURCE_ID,
  prune: true,
  async collect(): Promise<CollectedBindings> {
    const { snapshots } = await snapshotAll();
    const bindings: PersistedBinding[] = [];
    const unverified: Array<{ agentId: string; targetId: string }> = [];
    for (const s of snapshots) {
      bindings.push(...s.resolution.members.map((member) => memberBinding(s.gp, s.membership, member)));
      unverified.push(...s.resolution.unverified.map((agentId) => ({ agentId, targetId: s.gp.id })));
    }
    // The first rebuild is the baseline: later changes are announced as joins and leaves.
    if (!listed) listed = new Map(snapshots.map((s) => [s.gp.id, new Set(s.resolution.members.map((m) => m.agentId))]));
    return { bindings, unverified };
  },
  afterRebuild(complete) {
    if (!complete || migrated) return;
    migrated = true;
    void migrateLegacyGroupProjects().then(() => { migrationDeferred = null; }, async (err) => {
      // telemetry-exempt: legacy group projects stay on their wires and the next rebuild retries; logged
      migrated = false;
      migrationDeferred = await canvasProblemSummary();
      appLog('core:group-project', 'warn', 'Group project membership migration deferred: a Canvas store could not be read completely', { meta: { error: err instanceof Error ? err.message : String(err) } });
    });
  },
};

/**
 * Give every group project without a record one: a new one auto-joins; one
 * from before keeps the members its wires gave it, nothing more, and gets the
 * one-time offer to include everyone in scope.
 */
async function migrateLegacyGroupProjects(): Promise<void> {
  const inventory = await readInventory();
  let wires: PersistedBinding[] | null = null;
  let changed = false;
  for (const gp of await groupProjectHost.list()) {
    // Only the host gives a group project its record (#3363).
    if (isReplica(gp) || await isMembershipManaged(gp.id)) continue;
    if (!isNewGroupProject(gp)) wires ??= await readCanvasWiresStrictly();
    await adopt(gp, inventory, wires ?? []);
    changed = true;
  }
  if (changed) await reconcileMembership();
}

function isNewGroupProject(gp: GroupProject): boolean {
  return Date.parse(gp.createdAt) >= startedAt;
}

/** Why migration is waiting, for the directory; null when it isn't. */
let migrationDeferred: string | null = null;

/** The Canvas stores that couldn't be read, in words a person can act on. */
async function canvasProblemSummary(): Promise<string> {
  const problems: string[] = [];
  try {
    for (const snapshot of await readAllCanvasStores({ strict: true })) {
      if (snapshot.problems.length === 0) continue;
      const where = snapshot.location.scope === 'app' ? 'the app-wide Canvas' : `project “${snapshot.location.projectName}”`;
      problems.push(snapshot.problems.some((p) => p.startsWith('Project folder is unavailable'))
        ? `the folder of ${where} is missing`
        : `${where} has a Canvas that couldn't be read completely`);
    }
  } catch {
    // telemetry-exempt: the summary falls back to a general reason
  }
  const what = problems.length > 0 ? problems.join('; ') : 'a Canvas couldn\'t be read completely';
  return `Members still come from Canvas wires, because ${what}. Restore the folder or remove the project; Clubhouse tries again when it next reloads connections.`;
}

/**
 * Every canvas wire, read strictly: a store that can't be read completely
 * refuses, so a legacy group project is never migrated with members missing.
 */
async function readCanvasWiresStrictly(): Promise<PersistedBinding[]> {
  const inspected = await canvasWireBindingSource.inspect!();
  return Array.isArray(inspected) ? inspected : inspected.bindings;
}

/**
 * Give a group project its record. A new one auto-joins. A legacy one keeps
 * exactly its members (live bindings and every canvas wire to it), each
 * with the tool switches and instructions its wire had, and gets the
 * one-time offer.
 */
async function adopt(gp: GroupProject, inventory: Inventory, canvasWires?: PersistedBinding[]): Promise<void> {
  if (isNewGroupProject(gp)) {
    await groupProjectHost.updateMembership(gp.id, (draft) => { draft.autoJoin = true; });
    appLog('core:group-project', 'info', 'New group project auto-joins agents in scope', { meta: { groupProjectId: gp.id } });
    return;
  }
  const wires = (canvasWires ?? await readCanvasWiresStrictly()).filter((w) => w.targetKind === 'group-project' && w.targetId === gp.id);
  const live = bindingManager.getAllBindings().filter((b) => b.targetKind === 'group-project' && b.targetId === gp.id);
  const pairs = new Map<string, { name?: string; disabledTools?: string[]; instructions?: Record<string, string> }>();
  for (const w of wires) {
    pairs.set(w.agentId, { name: w.agentName, disabledTools: w.disabledTools, instructions: w.instructions });
  }
  for (const b of live) {
    const wire = pairs.get(b.agentId);
    // The live binding's switches are the effective ones; a wire's instructions are its own (not a saved override).
    pairs.set(b.agentId, {
      name: b.agentName ?? wire?.name,
      disabledTools: b.disabledTools ?? wire?.disabledTools,
      instructions: wire?.instructions ?? b.instructions,
    });
  }
  const now = new Date().toISOString();
  const quick = knownQuickAgents();
  await groupProjectHost.updateMembership(gp.id, (draft) => {
    draft.autoJoin = false;
    draft.autoJoinOffer = 'pending';
    for (const [agentId, pair] of pairs) {
      if (pair.disabledTools?.length) draft.disabledTools = { ...draft.disabledTools, [agentId]: [...pair.disabledTools] };
      if (pair.instructions && Object.keys(pair.instructions).length > 0) draft.instructions = { ...draft.instructions, [agentId]: { ...pair.instructions } };
      if (draft.explicit.some((e) => e.address === agentId)) continue;
      const run = quick.get(agentId);
      const kind: GroupProjectMemberKind = run ? 'quick' : inventory.agents.get(agentId)?.helper ? 'helper' : 'durable';
      draft.explicit.push({
        address: agentId, kind, addedAt: now, ...(pair.name && { name: pair.name }),
        ...(run && { runId: quickRunId(agentId, run.startedAt) }),
      });
    }
  });
  appLog('core:group-project', 'info', 'Migrated group project members from wires', { meta: { groupProjectId: gp.id, members: pairs.size } });
}

/**
 * Bring bindings in step with every record: new members are claimed (their
 * join is announced), members that left are released. Also gives a group
 * project created since startup its record, and tidies entries for agents
 * that are gone. Runs after every change here and, debounced, after agent,
 * project and registry changes.
 */
export async function reconcileMembership(): Promise<void> {
  if (!listed) return; // Before the first rebuild: it binds everything.
  if (migrated) {
    const inventory = await readInventory();
    for (const gp of await groupProjectHost.list()) {
      if (!isReplica(gp) && !(await isMembershipManaged(gp.id)) && isNewGroupProject(gp)) await adopt(gp, inventory);
    }
  }
  const { snapshots, inventory, quick } = await snapshotAll();
  const next = new Map<string, Set<string>>();
  const changed = new Set<string>();
  for (const s of snapshots) {
    const ids = new Set(s.resolution.members.map((m) => m.agentId));
    next.set(s.gp.id, ids);
    const before = listed.get(s.gp.id) ?? new Set<string>();
    for (const member of s.resolution.members) {
      if (before.has(member.agentId)) continue;
      const binding = memberBinding(s.gp, s.membership, member);
      const outcome = claimSourceBinding(GROUP_PROJECT_MEMBERSHIP_SOURCE_ID, binding);
      if (outcome === 'created' && binding.disabledTools) bindingManager.setDisabledTools(member.agentId, s.gp.id, binding.disabledTools);
      changed.add(s.gp.id);
    }
    const unverified = new Set(s.resolution.unverified);
    for (const agentId of before) {
      if (ids.has(agentId)) continue;
      if (unverified.has(agentId)) { ids.add(agentId); continue; }
      releaseSourceBinding(GROUP_PROJECT_MEMBERSHIP_SOURCE_ID, agentId, s.gp.id);
      changed.add(s.gp.id);
    }
    // Judged against this machine's agents: never for a group project hosted elsewhere (#3363).
    if (!isReplica(s.gp)) await tidy(s, inventory, quick);
  }
  for (const [gpId, before] of listed) {
    if (next.has(gpId)) continue;
    for (const agentId of before) releaseSourceBinding(GROUP_PROJECT_MEMBERSHIP_SOURCE_ID, agentId, gpId);
    changed.add(gpId);
  }
  listed = next;
  for (const gpId of changed) notify(gpId);
}

/** Drop explicit entries whose agent is gone for good: a deleted or disposed helper, a finished quick run. */
async function tidy(s: Snapshot, inventory: Inventory, quick: ReadonlyMap<string, QuickFact>): Promise<void> {
  const gone = (e: GroupProjectMembership['explicit'][number]): boolean => {
    if (e.kind === 'quick') {
      const run = quick.get(e.address);
      return !run || (!!e.runId && e.runId !== run.runId);
    }
    if (inventory.unreadable.size > 0) return false;
    const agent = inventory.agents.get(e.address);
    return !agent || agent.disposed;
  };
  // Only the entries judged here: one added since (a new run of the same agent) stays.
  const stale = s.membership.explicit.filter(gone);
  if (stale.length === 0) return;
  const same = (a: GroupProjectMembership['explicit'][number], b: GroupProjectMembership['explicit'][number]) =>
    a.address === b.address && a.addedAt === b.addedAt && a.runId === b.runId;
  await groupProjectHost.updateMembership(s.gp.id, (draft) => {
    draft.explicit = draft.explicit.filter((e) => !stale.some((old) => same(old, e)));
  });
}

let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileChain: Promise<void> = Promise.resolve();

function runReconcile(): Promise<void> {
  reconcileChain = reconcileChain.then(reconcileMembership).catch((err) => {
    // telemetry-exempt: the next change retries; logged
    appLog('core:group-project', 'error', 'Group project membership reconcile failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
  });
  return reconcileChain;
}

function scheduleReconcile(): void {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => { reconcileTimer = null; void runReconcile(); }, 250);
}

let stopWatching: (() => void) | null = null;

/** Follow agent, project, quick-run and registry changes. Returns the stop. */
export function watchGroupProjectMembership(): () => void {
  if (stopWatching) return stopWatching;
  const offs = [
    onAgentConfigChanged(() => scheduleReconcile()),
    projectStore.onProjectsChanged(() => scheduleReconcile()),
    groupProjectHost.onChange((change) => {
      // A deleted group project's members go at once; its record went with it.
      if (change.part === 'deleted') releaseMembershipBindings(change.groupProjectId);
      else scheduleReconcile();
    }),
    onAppEvent((event) => {
      if (event.type === 'agent.quick_finished' || event.type === 'agent.created' || event.type === 'agent.deleted') scheduleReconcile();
    }),
  ];
  // Who is a member, for the host's own readers (scope preview, #3355).
  groupProjectHost.setMemberResolver(async (gp, membership) => {
    if (!isManagedMembership(membership)) return (await describeMembership(gp.id)).members.map(toMemberView);
    const [inventory, quick] = await Promise.all([readInventory(), liveQuickAgents()]);
    return resolveMembership(gp, membership, inventory, quick).members.map(toMemberView);
  });
  stopWatching = () => {
    groupProjectHost.setMemberResolver(null);
    for (const off of offs) off();
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    stopWatching = null;
  };
  return stopWatching;
}

// ── Changes ─────────────────────────────────────────────────────────────────

async function requireGroupProject(groupProjectId: string): Promise<GroupProject> {
  const gp = await groupProjectHost.get(groupProjectId);
  if (!gp) throw new Error(`Group project ${groupProjectId} does not exist.`);
  return gp;
}

/**
 * A group project just created: every top-level durable agent in its scope
 * joins, now and later. Call right after creating it.
 */
export async function beginAutoJoin(groupProjectId: string): Promise<void> {
  await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    if (!isManagedMembership(draft)) draft.autoJoin = true;
  });
  await runReconcile();
}

/**
 * Add an agent: removes its exclusion, and records it as an explicit member
 * unless auto-join already includes it. A quick agent is added for its
 * current run only. A group project still on wires becomes managed first.
 */
export async function addMember(groupProjectId: string, agentId: string): Promise<GroupProjectMembershipView> {
  const gp = await requireGroupProject(groupProjectId);
  const [inventory, quick] = await Promise.all([readInventory(), liveQuickAgents()]);
  const replica = isReplica(gp);
  if (!replica && !(await isMembershipManaged(gp.id))) await adopt(gp, inventory);
  const agent = inventory.agents.get(agentId);
  const run = quick.get(agentId);
  if (!run && (!agent || agent.disposed)) throw new Error('That agent does not exist here.');
  if (run && replica) throw new Error('A quick agent joins a group project only on the machine that hosts it.');
  // Host-relative (#3363): a bare id on the host, `id@<this machine>` on a copy.
  const address = groupProjectHost.memberAddress(gp, agentId);
  const now = new Date().toISOString();
  await groupProjectHost.updateMembership(gp.id, (draft) => {
    draft.excluded = draft.excluded.filter((e) => e.address !== address);
    // Who auto-joins is the host's to decide; a copy only records the addition.
    const auto = !replica && draft.autoJoin && agent && !agent.helper && inScope(gp, agent);
    if (auto || draft.explicit.some((e) => e.address === address && (!run || e.runId === run.runId))) return;
    draft.explicit = draft.explicit.filter((e) => e.address !== address);
    draft.explicit.push(run
      ? { address, kind: 'quick', addedAt: now, runId: run.runId, name: run.name }
      : { address, kind: agent!.helper ? 'helper' : 'durable', addedAt: now, name: agent!.name });
  });
  // A wire the user deleted earlier this session is theirs to bring back: this is that.
  clearBindingRemovedByUser(agentId, gp.id);
  await runReconcile();
  return describeMembership(gp.id);
}

/**
 * Take an agent out. A durable agent is excluded, so auto-join never brings
 * it back; a helper or quick agent just loses its explicit entry.
 */
export async function excludeMember(groupProjectId: string, agentId: string): Promise<GroupProjectMembershipView> {
  const gp = await requireGroupProject(groupProjectId);
  const inventory = await readInventory();
  if (!isReplica(gp) && !(await isMembershipManaged(gp.id))) await adopt(gp, inventory);
  const agent = inventory.agents.get(agentId);
  const quick = await liveQuickAgents();
  const address = groupProjectHost.memberAddress(gp, agentId);
  const now = new Date().toISOString();
  await groupProjectHost.updateMembership(gp.id, (draft) => {
    const entry = draft.explicit.find((e) => e.address === address);
    draft.explicit = draft.explicit.filter((e) => e.address !== address);
    // A helper or quick agent only loses its entry. Anyone else is excluded,
    // including an agent whose project can't be read now.
    const addedOnly = agent ? agent.helper : quick.has(agentId) || entry?.kind === 'helper' || entry?.kind === 'quick';
    if (!addedOnly && !draft.excluded.some((e) => e.address === address)) {
      draft.excluded.push({ address, excludedAt: now });
    }
  });
  await runReconcile();
  return describeMembership(gp.id);
}

/** Answer the one-time offer: accepting turns auto-join on, so everyone in scope joins. */
export async function answerAutoJoinOffer(groupProjectId: string, accept: boolean): Promise<GroupProjectMembershipView> {
  await requireGroupProject(groupProjectId);
  await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    if (draft.autoJoinOffer !== 'pending') return;
    draft.autoJoinOffer = accept ? 'accepted' : 'dismissed';
    if (accept) draft.autoJoin = true;
  });
  await runReconcile();
  return describeMembership(groupProjectId);
}

/** Keep a member's own tool switches (#2084), so the binding the record makes after a restart has them. */
export async function recordMemberDisabledTools(groupProjectId: string, agentId: string, disabledTools: string[]): Promise<void> {
  if (!(await isMembershipManaged(groupProjectId))) return;
  await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    draft.disabledTools = { ...draft.disabledTools, [agentId]: [...disabledTools] };
  });
}

/** A member's saved tool switches, or undefined when none were saved. */
export async function savedMemberDisabledTools(groupProjectId: string, agentId: string): Promise<string[] | undefined> {
  if (!(await isMembershipManaged(groupProjectId))) return undefined;
  const saved = (await groupProjectHost.getMembership(groupProjectId)).disabledTools?.[agentId];
  return Array.isArray(saved) ? [...saved] : undefined;
}

/** Whether an agent is a member now, by the record. */
export async function isMember(groupProjectId: string, agentId: string): Promise<boolean> {
  return (await describeMembership(groupProjectId)).members.some((m) => m.agentId === agentId);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Members, exclusions and the offer, for the directory and the delete impact check. */
export async function describeMembership(groupProjectId: string): Promise<GroupProjectMembershipView> {
  const gp = await requireGroupProject(groupProjectId);
  const membership = await groupProjectHost.getMembership(groupProjectId);
  const managed = isManagedMembership(membership);
  const [inventory, quick] = await Promise.all([readInventory(), liveQuickAgents()]);
  const nameOf = (id: string, fallback?: string) => inventory.agents.get(id)?.name ?? quick.get(id)?.name ?? fallback ?? id;
  let members: ResolvedGroupProjectMember[];
  if (managed) {
    members = resolveMembership(gp, membership, inventory, quick).members;
  } else {
    // Still on wires: the live bindings are the members.
    members = bindingManager.getAllBindings()
      .filter((b) => b.targetKind === 'group-project' && b.targetId === gp.id)
      .map((b) => {
        const agent = inventory.agents.get(b.agentId);
        const kind: GroupProjectMemberKind = quick.has(b.agentId) ? 'quick' : agent?.helper ? 'helper' : 'durable';
        return { agentId: b.agentId, name: b.agentName || nameOf(b.agentId), kind, via: 'explicit' as const, ...(agent && { projectId: agent.projectId, projectName: agent.projectName }) };
      });
  }
  const view: GroupProjectMembershipView = {
    groupProjectId,
    managed,
    ...(!managed && migrationDeferred && { deferred: migrationDeferred }),
    autoJoin: membership.autoJoin,
    members,
    excluded: membership.excluded.map((e) => ({ agentId: e.address, name: nameOf(e.address), excludedAt: e.excludedAt })),
  };
  if (membership.autoJoinOffer) {
    const current = new Set(members.map((m) => m.agentId));
    const excluded = new Set(membership.excluded.map((e) => e.address));
    const wouldJoin = autoCandidates(gp, inventory)
      .filter((a) => !current.has(a.id) && !excluded.has(a.id))
      .map((a): ResolvedGroupProjectMember => ({ agentId: a.id, name: a.name, kind: 'durable', via: 'auto', projectId: a.projectId, projectName: a.projectName }));
    view.autoJoinOffer = { state: membership.autoJoinOffer, wouldJoin };
  }
  return view;
}

/**
 * Who would auto-join a group project with this scope, before it's created:
 * the same inventory and rules as auto-join. Projects whose agents can't be
 * read are listed, since their agents would join once readable.
 */
export async function previewAutoJoin(untrusted: unknown): Promise<AutoJoinPreview> {
  const [inventory, projects] = await Promise.all([readInventory(), projectStore.list()]);
  // The same check creation makes: a known shape, a registered project.
  const scope: GroupProjectScope = resolveGroupProjectScope({ scope: untrusted }, new Set(projects.map((p) => p.id)));
  const gp = { id: 'preview', name: '', description: '', instructions: '', createdAt: '', metadata: {}, scope } as GroupProject;
  return {
    wouldJoin: autoCandidates(gp, inventory).map((a): ResolvedGroupProjectMember => ({
      agentId: a.id, name: a.name, kind: 'durable', via: 'auto', projectId: a.projectId, projectName: a.projectName,
    })),
    unreadableProjects: projects
      .filter((p) => inventory.unreadable.has(p.id) && (scope.level === 'app' || scope.projectId === p.id))
      .map((p) => ({ projectId: p.id, name: p.displayName || p.name })),
  };
}

function toMemberView(m: ResolvedGroupProjectMember): GroupProjectMemberView {
  return { address: m.agentId, name: m.name, ...(m.projectId && { projectId: m.projectId }) };
}

/**
 * Release every binding a group project's record holds, with no store read or
 * write: for a delete cascade that holds the host's lock (#3364). Idempotent.
 */
export function releaseMembershipBindings(groupProjectId: string): void {
  const held = listed?.get(groupProjectId);
  for (const agentId of held ?? []) releaseSourceBinding(GROUP_PROJECT_MEMBERSHIP_SOURCE_ID, agentId, groupProjectId);
  listed?.delete(groupProjectId);
  notify(groupProjectId);
}


/** For tests. */
export function _resetMembershipForTesting(): void {
  listed = null;
  migrated = false;
  listeners.clear();
  stopWatching?.();
  reconcileChain = Promise.resolve();
}

/** For tests: mark the first rebuild done without running one. */
export function _setMembershipBaselineForTesting(baseline: Map<string, Set<string>>, isMigrated = true): void {
  listed = baseline;
  migrated = isMigrated;
}
