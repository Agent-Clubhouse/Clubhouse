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
 *   "Include every agent in scope" once. A new app group starts empty; a project group auto-joins by default.
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

import type { WriteAuthor } from '../../shared/group-project-network';
import type {
  AutoJoinPreview, GroupProject, GroupProjectMembershipOptions, GroupProjectScope, GroupProjectMemberKind, GroupProjectMembership, GroupProjectMembershipView, GroupProjectMemberView, ResolvedGroupProjectMember,
} from '../../shared/group-project-types';
import { GroupProjectHostError, groupProjectHost, requireExactLeavingReview } from './group-project-host';
import * as projectStore from './project-store';
import { listDurable, onAgentConfigChanged } from './agent-config';
import { knownQuickAgents } from './quick-agent-events';
import { onAppEvent, publishAppEvent } from './app-event-bus';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  claimSourceBinding, clearBindingRemovedByUser, releaseSourceBinding,
  type CollectedBindings, type PersistedBinding, type PersistedBindingSource,
} from './persisted-bindings';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { parseAgentAddress } from '../../shared/agent-address';
import { resolveGroupProjectScope } from '../../shared/group-project-scope';
import { canvasWireBindingSource } from './canvas-wire-source';
import { setRecordDecidesMembers } from './group-project-lifecycle';
import { readAllCanvasStores } from './canvas-store-reader';
import { appLog } from './log-service';
import { linkedAgents, previewLinkedAgents, linkedProjectCopies, watchLinkedAgents } from './group-project-linked-agents';
import { groupProjectLabel } from '../../shared/group-project-labels';
import { previewCoverage } from './group-project-coverage';

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
  return m.membershipPolicy === 'project-3546' || m.autoJoin || m.autoJoinOffer !== undefined;
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
    members.set(id, { agentId: id, name: agent.name, kind: agent.helper ? 'helper' : 'durable', via: entry.autoProject ? 'auto' : 'explicit', projectId: agent.projectId, projectName: agent.projectName });
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
    if (groupProjectHost.localAgentId(gp, entry.address) === null) {
      members.set(entry.address, {
        agentId: entry.address, name: entry.name ?? entry.address, kind: entry.kind,
        via: entry.autoProject ? 'auto' : 'explicit', projectId: entry.projectId, projectName: entry.projectName,
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

/** Re-read inventory at admission commit time; a reconcile snapshot is only a proposal. */
export async function currentAdmissionMembers(gp: GroupProject, membership: GroupProjectMembership): Promise<Map<string, string>> {
  const [inventory, quick] = await Promise.all([readInventory(), liveQuickAgents()]);
  return new Map(resolveMembership(gp, membership, inventory, quick).members.map(m => [groupProjectHost.addressOf(gp, m.agentId), m.name]));
}

/**
 * The key a member's own entries (tool switches, instructions) have in the
 * record. The record is the host's, so keys are host-relative addresses: on a
 * copy this machine's agents are `id@<self>` (#3516), on the host a bare id.
 */
export function memberPolicyKey(gp: GroupProject, agentId: string): string {
  return groupProjectHost.addressOf(gp, agentId);
}

/** Resolved replica members are already local ids; hosted records also contain remote addresses. */
function localMembers(snapshot: Snapshot): ResolvedGroupProjectMember[] {
  return snapshot.resolution.members.filter((member) => isReplica(snapshot.gp)
    || groupProjectHost.localAgentId(snapshot.gp, member.agentId) !== null);
}

function memberBinding(gp: GroupProject, m: GroupProjectMembership, member: ResolvedGroupProjectMember): PersistedBinding {
  const key = memberPolicyKey(gp, member.agentId);
  const own = m.disabledTools?.[key];
  const fallback = gp.metadata?.defaultDisabledTools;
  const disabledTools = Array.isArray(own) ? own
    : Array.isArray(fallback) && fallback.every((t) => typeof t === 'string') ? fallback as string[] : undefined;
  const instructions = m.instructions?.[key];
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
    if (!isReplica(gp)) await reconcileLinkedMembers(gp);
    const membership = await groupProjectHost.getMembership(gp.id);
    if (!isManagedMembership(membership)) { managedSeen.delete(gp.id); continue; }
    managedSeen.add(gp.id);
    snapshots.push({ gp, membership, resolution: resolveMembership(gp, membership, inventory, quick) });
  }
  return { snapshots, inventory, quick };
}

/** Group projects known to take their members from their record, for synchronous checks. */
const managedSeen = new Set<string>();
// The lifecycle's guard against stale wire restores doesn't apply to these: the record binds.
setRecordDecidesMembers((id) => managedSeen.has(id));

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
      bindings.push(...localMembers(s).map((member) => memberBinding(s.gp, s.membership, member)));
      unverified.push(...s.resolution.unverified.map((agentId) => ({ agentId, targetId: s.gp.id })));
    }
    // The first rebuild is the baseline: later changes are announced as joins and leaves.
    if (!listed) listed = new Map(snapshots.map((s) => [s.gp.id, new Set(localMembers(s).map((m) => m.agentId))]));
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
 * Give every group project without a record one: a new project group auto-joins; one
 * from before keeps the members its wires gave it, nothing more, and gets the
 * one-time offer to include everyone in scope.
 */
async function migrateLegacyGroupProjects(): Promise<void> {
  const inventory = await readInventory();
  let wires: PersistedBinding[] | null = null;
  for (const gp of await groupProjectHost.list()) {
    // Only the host gives a group project its record (#3363).
    if (isReplica(gp) || await isMembershipManaged(gp.id)) continue;
    if (!isNewGroupProject(gp)) wires ??= await readCanvasWiresStrictly();
    await adopt(gp, inventory, wires ?? []);
  }
  // Also repair missing admissions in groups already managed before this launch.
  await reconcileMembership();
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
 * Give a group project its record. A new project group auto-joins. A legacy one keeps
 * exactly its members (live bindings and every canvas wire to it), each
 * with the tool switches and instructions its wire had, and gets the
 * one-time offer.
 */
async function adopt(gp: GroupProject, inventory: Inventory, canvasWires?: PersistedBinding[]): Promise<void> {
  if (isNewGroupProject(gp)) {
    await groupProjectHost.updateMembership(gp.id, (draft) => {
      draft.autoJoin = gp.scope?.level === 'project';
      draft.membershipPolicy = 'project-3546';
      draft.includeLinkedComputers = gp.scope?.level === 'project' && gp.scope.reach === 'network';
    });
    appLog('core:group-project', 'info', 'New group project membership initialized', { meta: { groupProjectId: gp.id } });
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
    if (!isReplica(s.gp) && s.resolution.members.length > 0) {
      await groupProjectHost.ensureMemberAdmissions(s.gp.id, s.resolution.members.map(member => ({ name: member.name, address: member.agentId })));
    }
    const ids = new Set(localMembers(s).map((m) => m.agentId));
    next.set(s.gp.id, ids);
    const before = listed.get(s.gp.id) ?? new Set<string>();
    for (const member of s.resolution.members) {
      if (!isReplica(s.gp) && groupProjectHost.localAgentId(s.gp, member.agentId) === null) continue;
      if (before.has(member.agentId)) continue;
      const binding = memberBinding(s.gp, s.membership, member);
      const outcome = claimSourceBinding(GROUP_PROJECT_MEMBERSHIP_SOURCE_ID, binding);
      if (outcome === 'created' && binding.disabledTools) bindingManager.setDisabledTools(member.agentId, s.gp.id, binding.disabledTools);
      publishAppEvent({ type: 'group_project.member_joined', groupProjectId: s.gp.id, memberAddress: member.agentId });
      changed.add(s.gp.id);
    }
    const unverified = new Set(s.resolution.unverified);
    for (const agentId of before) {
      if (ids.has(agentId)) continue;
      if (unverified.has(agentId)) { ids.add(agentId); continue; }
      releaseSourceBinding(GROUP_PROJECT_MEMBERSHIP_SOURCE_ID, agentId, s.gp.id);
      publishAppEvent({ type: 'group_project.member_left', groupProjectId: s.gp.id, memberAddress: agentId });
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
  const linked = s.membership.explicit.some((entry) => groupProjectHost.localAgentId(s.gp, entry.address) === null)
    ? await linkedAgents(s.gp.scope, groupProjectHost.selfMachine(), (machine) => groupProjectHost.isNetworkMember(machine)) : null;
  const gone = (e: GroupProjectMembership['explicit'][number]): boolean => {
    if (e.kind === 'quick') {
      const run = quick.get(e.address);
      return !run || (!!e.runId && e.runId !== run.runId);
    }
    if (groupProjectHost.localAgentId(s.gp, e.address) === null) {
      const machine = parseAgentAddress(e.address).machine;
      const copyKey = `${machine}/${e.projectId}`;
      const verified = linked?.copies.some((copy) => copy.machine === machine && copy.projectId === e.projectId)
        && !linked.unknown.some((copy) => copy.projectId === copyKey);
      return !!verified && !linked?.available.some((agent) => agent.agentId === e.address && agent.projectId === e.projectId);
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
    watchLinkedAgents(() => {
      scheduleReconcile();
      // Also refresh previews when a link disappears without changing any local bindings.
      void groupProjectHost.list().then((groups) => groups.forEach((gp) => notify(gp.id))).catch((error) => {
        // telemetry-exempt: the scheduled reconcile retries and logs the underlying read failure
        appLog('core:group-project', 'warn', 'Could not refresh linked membership previews', { meta: { error: String(error) } });
      });
    }),
    onAgentConfigChanged(() => scheduleReconcile()),
    projectStore.onProjectsChanged(() => scheduleReconcile()),
    groupProjectHost.onChange((change) => {
      // A deleted group project's members go at once; its record went with it.
      if (change.part === 'deleted') releaseMembershipBindings(change.groupProjectId);
      else {
        scheduleReconcile();
        // Remote-only changes have no local binding delta to announce. A scope
        // change also commits its membership before the host emits the record event.
        if (change.part === 'membership' || change.part === 'record') notify(change.groupProjectId);
      }
    }),
    onAppEvent((event) => {
      if (event.type === 'agent.quick_finished' || event.type === 'agent.created' || event.type === 'agent.deleted') scheduleReconcile();
    }),
  ];
  // Who is a member, for the host's own readers (scope preview, #3355).
  groupProjectHost.setMemberResolver(async (gp, membership) => {
    if (!isManagedMembership(membership)) return (await describeMembership(gp.id)).members.map(m => toMemberView(gp, m));
    const [inventory, quick] = await Promise.all([readInventory(), liveQuickAgents()]);
    return resolveMembership(gp, membership, inventory, quick).members.map(m => toMemberView(gp, m));
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

/** Persist remote auto members on the host; only this inventory is allowed to add them. */
async function reconcileLinkedMembers(gp: GroupProject): Promise<void> {
  const current = await groupProjectHost.getMembership(gp.id);
  if (current.membershipPolicy !== 'project-3546' || !current.autoJoin || !current.includeLinkedComputers) return;
  await groupProjectHost.updateMembership(gp.id, async (draft) => {
    if (!draft.autoJoin || !draft.includeLinkedComputers) return;
    const linked = await linkedAgents(gp.scope, groupProjectHost.selfMachine(), (machine) => groupProjectHost.isNetworkMember(machine));
    const excluded = new Set(draft.excluded.map((entry) => entry.address));
    // Unknown/offline copies keep their saved members. An unlink is held for the person's review.
    const verifiedCopies = new Set(linked.copies.map((copy) => `${copy.machine}/${copy.projectId}`)
      .filter((key) => !linked.unknown.some((copy) => copy.projectId === key)));
    const eligible = new Set(linked.agents.map((agent) => agent.agentId));
    draft.explicit = draft.explicit.filter((entry) => !entry.autoProject
      || !verifiedCopies.has(`${entry.autoProject.machine}/${entry.autoProject.projectId}`) || eligible.has(entry.address));
    for (const agent of linked.agents) {
      if (excluded.has(agent.agentId) || draft.explicit.some((entry) => entry.address === agent.agentId)) continue;
      draft.explicit.push({ address: agent.agentId, kind: 'durable', name: agent.name, addedAt: new Date().toISOString(),
        autoProject: { machine: agent.machine, projectId: agent.projectId! }, projectId: agent.projectId, projectName: agent.projectName });
    }
  });
}

/** Unlinked automatic members remain members until a matching review is applied. */
function coverageLeaving(gp: GroupProject, membership: GroupProjectMembership): ResolvedGroupProjectMember[] {
  if (gp.scope?.level !== 'project') return [];
  const copies = linkedProjectCopies(groupProjectHost.selfMachine(), gp.scope.projectId);
  return membership.explicit.filter((entry) => entry.autoProject && !membership.excluded.some((e) => e.address === entry.address)
    && !copies.some((copy) => copy.machine === entry.autoProject!.machine && copy.projectId === entry.autoProject!.projectId))
    .map((entry) => ({ agentId: entry.address, name: entry.name ?? entry.address, kind: entry.kind, via: 'auto', projectId: entry.projectId, projectName: entry.projectName }));
}

export async function confirmUnlinkedMembers(groupProjectId: string, confirmLeaving: string[]): Promise<GroupProjectMembershipView> {
  const gp = await requireGroupProject(groupProjectId);
  if (isReplica(gp)) throw new GroupProjectHostError('not_host', 'Only the host can review linked membership.');
  await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    const leaving = coverageLeaving(gp, draft), confirmed = new Set(confirmLeaving);
    requireExactLeavingReview(leaving.map((member) => member.agentId), confirmLeaving);
    draft.explicit = draft.explicit.filter((entry) => !confirmed.has(entry.address));
  });
  await runReconcile();
  notify(groupProjectId);
  return describeMembership(groupProjectId);
}

/** Host-only toggles. Turning either off first materialises everyone it currently includes. */
export async function setAutomaticMembership(groupProjectId: string, options: GroupProjectMembershipOptions): Promise<GroupProjectMembershipView> {
  const gp = await requireGroupProject(groupProjectId);
  if (isReplica(gp)) throw new GroupProjectHostError('not_host', 'Only the host can change automatic membership.');
  if (gp.scope?.level !== 'project') throw new GroupProjectHostError('invalid', 'Automatic membership controls require a project group.');
  if (!options || typeof options.autoJoin !== 'boolean' || typeof options.includeLinkedComputers !== 'boolean') throw new Error('Invalid automatic membership options.');
  if (!(await isMembershipManaged(gp.id))) await adopt(gp, await readInventory());
  await groupProjectHost.updateMembership(groupProjectId, async (draft) => {
    if (coverageLeaving(gp, draft).length > 0) {
      throw new Error('Review who leaves the unlinked project copy before changing automatic membership.');
    }
    if (draft.membershipPolicy !== 'project-3546') {
      const linked = await linkedAgents(gp.scope, groupProjectHost.selfMachine(), (machine) => groupProjectHost.isNetworkMember(machine));
      for (const entry of draft.explicit) {
        if (groupProjectHost.localAgentId(gp, entry.address) !== null) continue;
        const remote = linked.available.find((agent) => agent.agentId === entry.address);
        if (!remote) throw new Error('Some remote members could not be verified in an explicitly linked project copy. Try again when their inventory is available.');
        entry.projectId = remote.projectId;
        entry.projectName = remote.projectName;
      }
    }
    const [inventory, quick] = await Promise.all([readInventory(), liveQuickAgents()]);
    if ((draft.autoJoin && !options.autoJoin) || (draft.includeLinkedComputers && !options.includeLinkedComputers)) {
      const current = resolveMembership(gp, draft, inventory, quick);
      // An unreadable inventory cannot materialise the complete current membership safely.
      if (current.unverified.length || (gp.scope?.level === 'project' && inventory.unreadable.has(gp.scope.projectId))) {
        throw new Error('Some current members could not be checked. Try again when their project is readable.');
      }
      for (const member of current.members) {
        const entry = draft.explicit.find((e) => e.address === member.agentId);
        if (entry) continue;
        draft.explicit.push({ address: member.agentId, kind: member.kind, name: member.name, addedAt: new Date().toISOString() });
      }
      // Exclusions can overlay saved entries. Including one again while off
      // must restore an explicit member, with no stale automatic source.
      for (const entry of draft.explicit) delete entry.autoProject;
    }
    draft.autoJoin = options.autoJoin;
    if (draft.autoJoinOffer === 'pending' && options.autoJoin) draft.autoJoinOffer = 'accepted';
    draft.includeLinkedComputers = gp.scope?.reach === 'network' && options.includeLinkedComputers;
    // Opting into the new controls is deliberate; no existing record is migrated automatically.
    draft.membershipPolicy = 'project-3546';
  });
  await runReconcile();
  notify(groupProjectId);
  return describeMembership(groupProjectId);
}

// ── Changes ─────────────────────────────────────────────────────────────────

async function requireGroupProject(groupProjectId: string): Promise<GroupProject> {
  const gp = await groupProjectHost.get(groupProjectId);
  if (!gp) throw new Error(`Group project ${groupProjectId} does not exist.`);
  return gp;
}

/**
 * Initialize the bindings for a newly created group's saved membership policy.
 * App groups start empty; project groups include eligible agents now and later.
 */
export async function beginAutoJoin(groupProjectId: string): Promise<void> {
  const gp = await requireGroupProject(groupProjectId);
  if (isReplica(gp)) throw new GroupProjectHostError('not_host', 'Only the host can initialize membership.');
  await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    if (!isManagedMembership(draft)) {
      draft.membershipPolicy = 'project-3546';
      draft.autoJoin = gp.scope?.level === 'project';
      draft.includeLinkedComputers = gp.scope?.level === 'project' && gp.scope.reach === 'network';
    }
  });
  await runReconcile();
}

/**
 * Add an agent: removes its exclusion, and records it as an explicit member
 * unless auto-join already includes it. A quick agent is added for its
 * current run only. A group project still on wires becomes managed first.
 */
export async function addMember(groupProjectId: string, agentId: string, options: { author?: WriteAuthor } = {}): Promise<GroupProjectMembershipView> {
  const gp = await requireGroupProject(groupProjectId);
  const [inventory, quick] = await Promise.all([readInventory(), liveQuickAgents()]);
  const replica = isReplica(gp);
  if (!replica && !(await isMembershipManaged(gp.id))) await adopt(gp, inventory);
  if (!replica && groupProjectHost.localAgentId(gp, agentId) === null) {
    const linked = await linkedAgents(gp.scope, groupProjectHost.selfMachine(), (machine) => groupProjectHost.isNetworkMember(machine));
    const remote = linked.available.find((agent) => agent.agentId === agentId);
    if (!remote) throw new GroupProjectHostError('out_of_scope', 'That agent must belong to an explicitly linked project copy with a verified inventory.');
    await groupProjectHost.updateMembership(gp.id, (draft) => {
      draft.excluded = draft.excluded.filter((entry) => entry.address !== agentId);
      if (!draft.explicit.some((entry) => entry.address === agentId)) draft.explicit.push({ address: agentId, kind: remote.kind, name: remote.name,
        projectId: remote.projectId, projectName: remote.projectName, addedAt: new Date().toISOString(),
        ...(remote.kind === 'durable' && draft.autoJoin && draft.includeLinkedComputers && { autoProject: { machine: remote.machine, projectId: remote.projectId! } }),
      });
    }, options);
    await runReconcile();
    notify(gp.id);
    return describeMembership(gp.id);
  }
  const agent = inventory.agents.get(agentId);
  const run = quick.get(agentId);
  if (!run && (!agent || agent.disposed)) throw new Error('That agent does not exist here.');
  if (run && replica) throw new Error('A quick agent joins a group project only on the machine that hosts it.');
  // Scope decides who can be added (#3355), for a person or an agent alike: an
  // explicit add can't put an outsider in or undo a narrowing. Fails closed.
  // Decided from this inventory's facts: an agent whose project isn't known is refused.
  const projectId = (run ?? agent)?.projectId;
  // On a copy of a group project hosted elsewhere, a project scope covers this computer's projects of the same
  // repository (#3363): the host service's check.
  const allowed = !gp.scope || gp.scope.level === 'app'
    || (replica ? await groupProjectHost.inScope(gp.id, agentId).catch(() => false) : projectId !== undefined && projectId === gp.scope.projectId);
  if (!allowed) {
    throw new GroupProjectHostError('out_of_scope', groupProjectHost.outOfScopeMessage(gp, agent?.name ?? run?.name ?? agentId));
  }
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
  }, options);
  // A wire the user deleted earlier this session is theirs to bring back: this is that.
  clearBindingRemovedByUser(agentId, gp.id);
  await runReconcile();
  return describeMembership(gp.id);
}

/**
 * Take an agent out. A durable agent is excluded, so auto-join never brings
 * it back; a helper or quick agent just loses its explicit entry.
 */
export async function excludeMember(groupProjectId: string, agentId: string, options: { author?: WriteAuthor } = {}): Promise<GroupProjectMembershipView> {
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
      draft.excluded.push({ address, excludedAt: now, name: agent?.name ?? entry?.name });
    }
  }, options);
  await runReconcile();
  return describeMembership(gp.id);
}

/** Answer the one-time offer: accepting turns auto-join on, so everyone in scope joins. */
export async function answerAutoJoinOffer(groupProjectId: string, accept: boolean, options: { author?: WriteAuthor } = {}): Promise<GroupProjectMembershipView> {
  await requireGroupProject(groupProjectId);
  await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    if (draft.autoJoinOffer !== 'pending') return;
    draft.autoJoinOffer = accept ? 'accepted' : 'dismissed';
    if (accept) draft.autoJoin = true;
  }, options);
  await runReconcile();
  return describeMembership(groupProjectId);
}

/** Keep a member's own tool switches (#2084), so the binding the record makes after a restart has them. */
export async function recordMemberDisabledTools(groupProjectId: string, agentId: string, disabledTools: string[], options: { author?: WriteAuthor } = {}): Promise<void> {
  if (!(await isMembershipManaged(groupProjectId))) return;
  const key = memberPolicyKey(await requireGroupProject(groupProjectId), agentId);
  await groupProjectHost.updateMembership(groupProjectId, (draft) => {
    draft.disabledTools = { ...draft.disabledTools, [key]: [...disabledTools] };
  }, options);
}

/** A member's saved tool switches, or undefined when none were saved. */
export async function savedMemberDisabledTools(groupProjectId: string, agentId: string): Promise<string[] | undefined> {
  if (!(await isMembershipManaged(groupProjectId))) return undefined;
  const key = memberPolicyKey(await requireGroupProject(groupProjectId), agentId);
  const saved = (await groupProjectHost.getMembership(groupProjectId)).disabledTools?.[key];
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
  const projects = await projectStore.list();
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
    includeLinkedComputers: membership.includeLinkedComputers ?? false,
    ...(gp.scope?.level === 'project' && { automaticMembership: {
      scope: gp.scope,
      projectName: projects.find((p) => p.id === (gp.scope?.level === 'project' ? gp.scope.projectId : ''))?.displayName
        || projects.find((p) => p.id === (gp.scope?.level === 'project' ? gp.scope.projectId : ''))?.name || 'this project',
      editable: !isReplica(gp),
    } }),
    coverageLeaving: isReplica(gp) ? [] : coverageLeaving(gp, membership),
    members,
    excluded: membership.excluded.map((e) => ({ agentId: e.address, name: nameOf(e.address, e.name), excludedAt: e.excludedAt })),
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
 * Whether this computer couldn't read every project a group it hosts covers,
 * so its members may be incomplete (#3548's roster says so).
 */
export async function hostInventoryPartial(gp: GroupProject): Promise<boolean> {
  const inventory = await readInventory();
  if (!gp.scope || gp.scope.level === 'app') return inventory.unreadable.size > 0;
  return inventory.unreadable.has(gp.scope.projectId);
}

/**
 * Who would auto-join a group project with this scope, before it's created:
 * the same inventory and rules as auto-join. Projects whose agents can't be
 * read are listed, since their agents would join once readable.
 */
export async function previewAutoJoin(untrusted: unknown, options?: GroupProjectMembershipOptions): Promise<AutoJoinPreview> {
  const [inventory, projects] = await Promise.all([readInventory(), projectStore.list()]);
  // The same check creation makes: a known shape, a registered project.
  const scope: GroupProjectScope = resolveGroupProjectScope({ scope: untrusted }, new Set(projects.map((p) => p.id)), groupProjectHost.scopeOptions().network);
  const linked: Pick<Awaited<ReturnType<typeof previewLinkedAgents>>, 'agents' | 'unknown' | 'copies' | 'lastSeen'> = options?.autoJoin !== false && options?.includeLinkedComputers !== false
    ? await previewLinkedAgents(scope, groupProjectHost.selfMachine(), (machine) => groupProjectHost.isNetworkMember(machine))
    : { agents: [], unknown: [], copies: [], lastSeen: [] };
  const exclusions = new Set(options?.excluded ?? []);
  const gp = { id: 'preview', name: '', description: '', instructions: '', createdAt: '', metadata: {}, scope } as GroupProject;
  const severalComputers = linked.copies.length > 0;
  return {
    coverage: await previewCoverage(scope),
    lastSeen: linked.lastSeen,
    wouldJoin: scope.level === 'app' || options?.autoJoin === false ? [] : [
      ...autoCandidates(gp, inventory).map((a): ResolvedGroupProjectMember => ({
        agentId: a.id, name: a.name, kind: 'durable', via: 'auto', projectId: a.projectId, projectName: `${groupProjectLabel(undefined, a.projectName, 'This project')}${severalComputers ? ' on this computer' : ''}`,
      })), ...linked.agents,
    ].filter((agent) => !exclusions.has(agent.agentId)),
    unreadableProjects: scope.level === 'app' || options?.autoJoin === false ? [] : [...linked.unknown, ...projects
      .filter((p) => inventory.unreadable.has(p.id) && scope.projectId === p.id)
      .map((p) => ({ projectId: p.id, name: `${groupProjectLabel(p.displayName, p.name, 'This project')}${severalComputers ? ' on this computer' : ''}`, reason: 'The project folder could not be read on this computer.' }))],
  };
}

function toMemberView(gp: GroupProject, m: ResolvedGroupProjectMember): GroupProjectMemberView {
  return { address: groupProjectHost.addressOf(gp, m.agentId), name: m.name, ...(m.projectId && { projectId: m.projectId }) };
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
