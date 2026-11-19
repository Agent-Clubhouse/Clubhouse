import { MAX_DELAY_MINUTES } from '../../shared/actions';
import type { QuickAgentOwner, TurnOutcome, QuickTemplateChoice, SpawnAgentParams } from '../../shared/types';
import { clearAgentChain, forgetHookTurn, publishAppEvent, setAgentChain } from './app-event-bus';
import type { AgentRegistration } from './agent-registry';

export interface QuickAgentRun {
  agentId: string;
  name: string;
  projectPath: string;
  parentAgentId?: string;
  owner: QuickAgentOwner;
  startedAt: number;
  chain: string[];
  outcome?: TurnOutcome;
  stopped?: boolean;
  finishedAt?: number;
  completion?: 'completed' | 'failed' | 'cancelled';
  /** Requested launch display metadata, never runtime confirmation, prompt, output or credentials. */
  display?: Readonly<QuickRunDisplay>;
}

export interface QuickRunDisplay {
  cwd: string;
  orchestrator?: string;
  model?: string;
  effort?: string;
  access?: SpawnAgentParams['access'];
  freeAgentMode?: boolean;
  permissionMode?: SpawnAgentParams['permissionMode'];
  approvalPolicy?: SpawnAgentParams['approvalPolicy'];
  sandbox?: SpawnAgentParams['sandbox'];
  template?: { id: string; added: readonly string[]; removed: readonly string[]; omitted: number };
}

const runs = new Map<string, QuickAgentRun>();
interface ObservedQuickRuntime {
  registration: AgentRegistration;
  nonce: string | undefined;
  display: Readonly<{ provider: string; runtime: AgentRegistration['runtime']; cwd?: string }>;
  isCurrent(): boolean;
}
let observedRuntimes = new WeakMap<QuickAgentRun, ObservedQuickRuntime>();

/** Called only with a specific created runtime, never a post-await ID lookup. No execution authority. */
export function noteQuickAgentRuntime(run: QuickAgentRun, registration: AgentRegistration | undefined, isCurrent: () => boolean): void {
  try {
    if (!registration || runs.get(run.agentId) !== run || run.finishedAt !== undefined || registration.projectPath !== run.projectPath || !isCurrent()) return;
    observedRuntimes.set(run, { registration, nonce: registration.nonce,
      display: Object.freeze({ provider: registration.orchestrator, runtime: registration.runtime, ...(registration.cwd && { cwd: registration.cwd }) }), isCurrent });
  } catch { /* telemetry-exempt: a display observation must never change the spawn's outcome. */ }
}

export function quickRuntimeIsCurrent(run: QuickAgentRun, registration: AgentRegistration | undefined): boolean {
  const observed = observedRuntimes.get(run);
  try { return !!observed && runs.get(run.agentId) === run && observed.registration === registration
    && registration?.projectPath === run.projectPath
    && registration?.nonce === observed.nonce && registration?.runtime === observed.display.runtime
    && registration?.orchestrator === observed.display.provider && registration?.cwd === observed.display.cwd && observed.isCurrent(); }
  catch { return false; /* telemetry-exempt: unavailable observation, never an effect. */ }
}

/** Safe historical metadata only; registration, nonce and runtime identity stay private. */
export function quickRuntimeDisplay(run: QuickAgentRun): ObservedQuickRuntime['display'] | undefined { return observedRuntimes.get(run)?.display; }

// Keep identity, scope and allowlisted launch display metadata, not prompt or output, through delayed delivery
// and its final rights check. Nothing is persisted in actions.json.
const FINISHED_RETENTION_MS = MAX_DELAY_MINUTES * 60_000;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFinishedExpiry(): void {
  if (expiryTimer) return;
  let nextExpiry = Infinity;
  for (const run of runs.values()) {
    if (run.finishedAt !== undefined) nextExpiry = Math.min(nextExpiry, run.finishedAt + FINISHED_RETENTION_MS);
  }
  if (!Number.isFinite(nextExpiry)) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    knownQuickAgents();
    scheduleFinishedExpiry();
  }, Math.max(0, nextExpiry - Date.now()) + 1);
  expiryTimer.unref?.();
}

export function knownQuickAgents(now = Date.now()): ReadonlyMap<string, QuickAgentRun> {
  for (const [id, run] of runs) {
    if (run.finishedAt !== undefined && now - run.finishedAt > FINISHED_RETENTION_MS) {
      runs.delete(id);
      forgetHookTurn(id);
    }
  }
  return runs;
}

export function beginQuickAgentRun(input: {
  agentId: string;
  projectPath: string;
  name?: string;
  parentAgentId?: string;
  quickOwner?: QuickAgentOwner;
  chain?: string[];
  cwd?: string;
  orchestrator?: string;
  model?: string;
  effort?: string;
  access?: SpawnAgentParams['access'];
  freeAgentMode?: boolean;
  permissionMode?: SpawnAgentParams['permissionMode'];
  approvalPolicy?: SpawnAgentParams['approvalPolicy'];
  sandbox?: SpawnAgentParams['sandbox'];
  managedTemplate?: QuickTemplateChoice;
}): QuickAgentRun {
  const previous = runs.get(input.agentId);
  if (previous) finishQuickAgentRun(previous, 'cancelled');
  forgetHookTurn(input.agentId);
  knownQuickAgents();
  const run: QuickAgentRun = {
    agentId: input.agentId,
    projectPath: input.projectPath,
    name: input.name ?? input.agentId,
    ...(input.parentAgentId && { parentAgentId: input.parentAgentId }),
    owner: input.quickOwner ?? { kind: 'user' },
    startedAt: Date.now(),
    chain: [...(input.chain ?? [])],
    display: Object.freeze({
      cwd: input.cwd ?? input.projectPath,
      ...(input.orchestrator !== undefined && { orchestrator: input.orchestrator }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.effort !== undefined && { effort: input.effort }),
      ...(input.access !== undefined && { access: input.access }),
      ...(input.freeAgentMode !== undefined && { freeAgentMode: input.freeAgentMode }),
      ...(input.permissionMode !== undefined && { permissionMode: input.permissionMode }),
      ...(input.approvalPolicy !== undefined && { approvalPolicy: input.approvalPolicy }),
      ...(input.sandbox !== undefined && { sandbox: input.sandbox }),
      ...(input.managedTemplate && { template: Object.freeze({ id: input.managedTemplate.id,
        added: Object.freeze([...(input.managedTemplate.addParts ?? [])].slice(0, 50)),
        removed: Object.freeze([...(input.managedTemplate.removeParts ?? [])].slice(0, 50)),
        omitted: Math.max(0, (input.managedTemplate.addParts?.length ?? 0) - 50) + Math.max(0, (input.managedTemplate.removeParts?.length ?? 0) - 50),
      }) }),
    }),
  };
  runs.set(run.agentId, run);
  if (run.chain.length) setAgentChain(run.agentId, run.chain, run.startedAt, true);
  return run;
}

export function noteQuickAgentTurn(agentId: string, outcome?: TurnOutcome): void {
  const run = runs.get(agentId);
  if (run && run.finishedAt === undefined) run.outcome = outcome;
}

export function noteQuickAgentStop(agentId: string): void {
  const run = runs.get(agentId);
  if (run && run.finishedAt === undefined) run.stopped = true;
}

export function finishQuickAgentRun(run: QuickAgentRun, outcome: 'completed' | 'failed' | 'cancelled'): void {
  if (run.finishedAt !== undefined) return;
  run.finishedAt = Date.now();
  run.completion = outcome;
  publishAppEvent({
    type: 'agent.quick_finished',
    agentId: run.agentId,
    name: run.name,
    owner: run.owner,
    ...(run.parentAgentId && { parentAgentId: run.parentAgentId }),
    projectPath: run.projectPath,
    durationMs: Math.max(0, run.finishedAt - run.startedAt),
    outcome,
    chain: [...run.chain],
    at: run.finishedAt,
  });
  if (runs.get(run.agentId) === run) clearAgentChain(run.agentId);
  scheduleFinishedExpiry();
}

export function finishQuickAgentExit(agentId: string, exitCode: number): void {
  const run = runs.get(agentId);
  if (!run) return;
  const outcome = run.stopped || run.outcome === 'interrupted' ? 'cancelled'
    : exitCode !== 0 || run.outcome === 'failed' ? 'failed' : 'completed';
  finishQuickAgentRun(run, outcome);
}

export function clearQuickAgentRuns(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  for (const id of runs.keys()) {
    clearAgentChain(id);
    forgetHookTurn(id);
  }
  runs.clear();
  observedRuntimes = new WeakMap();
}
