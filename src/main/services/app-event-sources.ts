/**
 * Feeds the app event bus (#2950) from facts the main process already has:
 * chat events, agent exits, and agent config changes (created, deleted, and
 * which agents are helpers). Agent starts, terminal hooks and project changes
 * publish where they happen (agent-system, hook-server, project-store).
 */

import { isDisposedAgent } from '../../shared/agent-helpers';
import type { AccessLevel } from '../../shared/agent-access';
import { resolveOrchestrationPolicy, type OrchestrationControl } from '../../shared/orchestration-policy';
import { agentAccess } from './free-agent-settings';
import type { DurableAgentConfig } from '../../shared/types';
import { listDurable, onAgentConfigChanged } from './agent-config';
import { onAgentExit } from './agent-exit-broadcast';
import { onChatEvent } from './agent-runtime/chat-event-bus';
import { forgetHookTurn, onAppEvent, publishAppEvent, publishFromChatEvent } from './app-event-bus';
import { appLog } from './log-service';
import * as projectStore from './project-store';
import { clearQuickAgentRuns, finishQuickAgentExit, knownQuickAgents, noteQuickAgentTurn } from './quick-agent-events';

export interface KnownAgent {
  projectPath: string;
  name?: string;
  parentAgentId?: string;
  worktreePath?: string;
  /** Its saved "Let this agent orchestrate" switch. */
  orchestrates?: boolean;
  /** Its saved Access level (#2761). */
  access?: AccessLevel;
  /** While it orchestrates: its saved cross-project helpers switch and approval setting, as its permissions read them (#2960). */
  crossProject?: boolean;
  control?: OrchestrationControl;
  quick?: boolean;
}

/** Agents that exist (created, not disposed), per project, from the last read. */
const projectAgents = new Map<string, Map<string, KnownAgent>>();
/** Every known agent by id, for helper lookups. */
const agents = new Map<string, KnownAgent>();

function exists(config: DurableAgentConfig): boolean {
  const state = config.creation?.state;
  return state !== 'creating' && state !== 'failed' && !isDisposedAgent(config);
}

function snapshot(projectPath: string, configs: DurableAgentConfig[]): Map<string, KnownAgent> {
  const out = new Map<string, KnownAgent>();
  for (const c of configs) {
    if (!exists(c)) continue;
    const policy = resolveOrchestrationPolicy(c.orchestration, { helper: !!c.parentAgentId });
    out.set(c.id, {
      projectPath,
      ...(c.name && { name: c.name }),
      ...(c.parentAgentId && { parentAgentId: c.parentAgentId }),
      ...(c.worktreePath && { worktreePath: c.worktreePath }),
      ...(c.orchestration?.orchestrate === true && { orchestrates: true }),
      // As launch and Preview read it: a record from before #2761 with its project's old mode.
      access: agentAccess(c, projectPath),
      ...(policy.orchestrate && { crossProject: policy.crossProjectHelpers, control: policy.control }),
    });
  }
  return out;
}

function remember(projectPath: string, next: Map<string, KnownAgent>): void {
  const prev = projectAgents.get(projectPath);
  if (prev) for (const id of prev.keys()) if (!next.has(id)) agents.delete(id);
  for (const [id, a] of next) agents.set(id, a);
  projectAgents.set(projectPath, next);
}

/** Compare a project's agents with the last read and publish created and deleted. */
export async function diffProjectAgents(projectPath: string): Promise<void> {
  let configs: DurableAgentConfig[];
  try {
    configs = await listDurable(projectPath);
  } catch (err) {
    // telemetry-exempt: logged; the next change reads again
    appLog('core:app-events', 'warn', 'Could not read agents for created and deleted events', {
      meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  const prev = projectAgents.get(projectPath);
  const next = snapshot(projectPath, configs);
  remember(projectPath, next);
  // The first read of a project is the baseline, not a burst of creations.
  if (!prev) return;
  const fields = (a: KnownAgent) => ({ ...(a.name && { name: a.name }), ...(a.parentAgentId && { parentAgentId: a.parentAgentId }) });
  for (const [id, a] of next) {
    if (!prev.has(id)) publishAppEvent({ type: 'agent.created', agentId: id, projectPath, ...fields(a) });
  }
  for (const [id, a] of prev) {
    if (!next.has(id)) publishAppEvent({ type: 'agent.deleted', agentId: id, projectPath, ...fields(a) });
  }
}

/** Forget a removed project's agents without publishing deletions. */
function forgetProject(projectPath: string): void {
  const prev = projectAgents.get(projectPath);
  if (prev) for (const id of prev.keys()) agents.delete(id);
  projectAgents.delete(projectPath);
}

/** Durable agents, plus quick-run identities retained for delayed event delivery. */
export function knownAgent(agentId: string): KnownAgent | undefined {
  const quick = knownQuickAgents().get(agentId);
  return agents.get(agentId) ?? (quick ? { ...quick, quick: true } : undefined);
}

/** All readable event sources, including quick agents and recent finishes. */
export function knownAgents(): ReadonlyMap<string, KnownAgent> {
  const all = new Map(agents);
  for (const [id, quick] of knownQuickAgents()) all.set(id, { ...quick, quick: true });
  return all;
}

/** The parent of a helper, from the last read of its project. */
export function knownHelperParent(agentId: string): { parentAgentId: string; projectPath: string } | undefined {
  const a = agents.get(agentId);
  return a?.parentAgentId ? { parentAgentId: a.parentAgentId, projectPath: a.projectPath } : undefined;
}

let stop: (() => void) | null = null;

/** Start feeding the bus. Reads every project once for the created and deleted baseline. */
export async function startAppEventSources(): Promise<void> {
  if (stop) return;
  // Serialized per project, so two quick writes can't publish the same creation twice.
  const pending = new Map<string, Promise<void>>();
  const queueDiff = (projectPath: string) => {
    const prev = pending.get(projectPath) ?? Promise.resolve();
    const next = prev.then(() => diffProjectAgents(projectPath));
    pending.set(projectPath, next);
    void next.finally(() => { if (pending.get(projectPath) === next) pending.delete(projectPath); });
  };
  const unsubs = [
    onChatEvent(publishFromChatEvent),
    onAgentExit((agentId, exitCode) => {
      // Quick runs retain their ended state alongside their identity so a
      // late CLI hook cannot end the same run again.
      if (!knownQuickAgents().has(agentId)) forgetHookTurn(agentId);
      publishAppEvent({ type: 'agent.asleep', agentId, exitCode });
      finishQuickAgentExit(agentId, exitCode);
    }),
    onAgentConfigChanged(queueDiff),
    onAppEvent((event) => {
      if (event.type === 'turn.ended') noteQuickAgentTurn(event.agentId, event.outcome);
      if (event.type === 'turn.started') noteQuickAgentTurn(event.agentId);
      // A project added later needs its own baseline, or its first agent goes unreported.
      if (event.type === 'project.added') { queueDiff(event.projectPath); return; }
      if (event.type === 'project.removed') { forgetProject(event.projectPath); return; }
      // A helper's finished turn is its parent's "helper finished".
      if (event.type !== 'turn.ended' || event.outcome !== 'completed') return;
      const parent = knownHelperParent(event.agentId);
      if (parent) publishAppEvent({ type: 'helper.finished', agentId: event.agentId, ...parent, ...(event.chain && { chain: event.chain }) });
    }),
  ];
  stop = () => { for (const u of unsubs) u(); };
  try {
    const projects = await projectStore.list();
    // Through the queue, so a change read during startup can't be compared with an older baseline.
    for (const p of projects) queueDiff(p.path);
    await Promise.all(projects.map((p) => pending.get(p.path)));
  } catch (err) {
    // telemetry-exempt: logged; created and deleted events start with the next change
    appLog('core:app-events', 'warn', 'Could not read projects for the agent baseline', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Publish "Clubhouse started", once its subscribers are listening. */
export function publishAppStarted(): void {
  publishAppEvent({ type: 'app.started' });
}

/** For tests. */
export function stopAppEventSources(): void {
  stop?.();
  stop = null;
  projectAgents.clear();
  agents.clear();
  clearQuickAgentRuns();
}
