import { MAX_DELAY_MINUTES } from '../../shared/actions';
import type { QuickAgentOwner, TurnOutcome } from '../../shared/types';
import { clearAgentChain, forgetHookTurn, publishAppEvent, setAgentChain } from './app-event-bus';

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
}

const runs = new Map<string, QuickAgentRun>();

// Keep only identity and scope, not prompt or output, through delayed delivery
// and its final rights check. Nothing is persisted in actions.json.
const FINISHED_RETENTION_MS = MAX_DELAY_MINUTES * 60_000;

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
}

export function finishQuickAgentExit(agentId: string, exitCode: number): void {
  const run = runs.get(agentId);
  if (!run) return;
  const outcome = run.stopped || run.outcome === 'interrupted' ? 'cancelled'
    : exitCode !== 0 || run.outcome === 'failed' ? 'failed' : 'completed';
  finishQuickAgentRun(run, outcome);
}

export function clearQuickAgentRuns(): void {
  for (const id of runs.keys()) {
    clearAgentChain(id);
    forgetHookTurn(id);
  }
  runs.clear();
}
