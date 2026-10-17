/**
 * Agent runtime telemetry (spec §4.4, Phase 4a): PTY and headless runs from
 * spawn to exit, readiness, exit classification, kill escalation, hook events,
 * tool calls, hook-path permissions, Clubhouse MCP tool calls and CLI binary
 * lookup.
 *
 * The runtime managers call these at their existing decision points. Nothing
 * here ever holds a span open: a run is replayed with explicit times when it
 * exits. On the PTY data path the only work is one Map lookup and an add.
 *
 * Phase 4b adds the agent kind (noted by spawnAgent just before the process
 * starts) and the `clubhouse.agent.kill` span, replayed at exit from the
 * moment killAgent was asked. The spawn tree lives in spawn-telemetry.ts.
 * Chat runs open here from the chat event bus (chat-telemetry.ts, spec §9.1)
 * and close on the same exit broadcast.
 *
 * No OpenTelemetry imports: part of the main bundle. The orchestrator lookup
 * is injected at install time so the runtime managers don't pick up a
 * dependency on the agent registry (and through it, every provider).
 */
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import { onAgentExit } from '../services/agent-exit-broadcast';
import { isTelemetryActive, replaySpan, tel } from './facade';

import { clearToolCalls } from './agent-signals';

export { recordBinaryLookup, recordHookEvent, recordMcpToolCall, recordPermission, toolBucket } from './agent-signals';

type Runtime = 'pty' | 'headless' | 'chat';
type Kind = Parameters<typeof ATTR.agentKind>[0];
type KillTrigger = Parameters<typeof ATTR.killTrigger>[0];
type Orchestrator = Parameters<typeof ATTR.orchestrator>[0];
type KillStage = Parameters<typeof ATTR.killStage>[0];
type ExitClass = Parameters<typeof ATTR.agentExitClass>[0];

/** An exit within this long of spawn, with a non-zero code, is an early failure (mirrors the renderer). */
export const EARLY_FAILURE_MS = 3000;

const KILL_ORDER: KillStage[] = ['exit_command', 'eof', 'sigterm', 'sigkill'];

interface Run {
  runtime: Runtime;
  kind?: Kind;
  orchestrator: Orchestrator;
  startMs: number;
  shellReady: boolean;
  firstOutput: boolean;
  bytes: number;
  killStage?: KillStage;
  swept: boolean;
  /** Set when killAgent asked for this run to stop. */
  kill?: { startMs: number; trigger: KillTrigger };
}

const runs = new Map<string, Run>();
/** Kinds noted by spawnAgent for a process about to start, keyed by agent id. */
const pendingKinds = new Map<string, Kind>();
let lookupOrchestrator: (agentId: string) => string | undefined = () => undefined;

function orchestratorOf(agentId: string): Orchestrator {
  const id = lookupOrchestrator(agentId);
  return id === 'claude-code' || id === 'codex-cli' || id === 'copilot-cli' ? id : 'other';
}

function base(run: Run): TelAttr[] {
  return [ATTR.agentRuntime(run.runtime), ATTR.orchestrator(run.orchestrator)];
}

/** spawnAgent: the next run started for `agentId` is of this kind. */
export function noteSpawnKind(agentId: string, kind: Kind): void {
  if (!isTelemetryActive()) return;
  pendingKinds.set(agentId, kind);
}

/** spawnAgent failed before a process started: forget the noted kind. */
export function clearSpawnKind(agentId: string): void {
  pendingKinds.delete(agentId);
}

/** killAgent was asked to stop this run. The kill span is replayed when the run ends. */
export function agentKillRequested(agentId: string, trigger: KillTrigger, atMs = Date.now()): void {
  const run = runs.get(agentId);
  if (!run || run.kill) return;
  run.kill = { startMs: atMs, trigger };
}

/** A PTY or headless agent process started. A previous run for the same id is closed as replaced. */
export function agentRunStarted(agentId: string, runtime: Runtime, atMs = Date.now()): void {
  if (!isTelemetryActive()) return;
  if (runs.has(agentId)) endRun(agentId, null, 'replaced', atMs);
  const kind = pendingKinds.get(agentId);
  pendingKinds.delete(agentId);
  runs.set(agentId, {
    runtime,
    kind,
    orchestrator: orchestratorOf(agentId),
    startMs: atMs,
    shellReady: false,
    firstOutput: false,
    bytes: 0,
    swept: false,
  });
}

/** True while a run is open for this agent (chat sessions use it so a context clear doesn't restart the run). */
export function hasActiveRun(agentId: string): boolean {
  return runs.has(agentId);
}

/** Drop a run without recording it (a chat start that fell back to the terminal never was a chat run). */
export function discardRun(agentId: string): void {
  runs.delete(agentId);
}

/** PTY only: the shell accepted the agent command. */
export function agentShellReady(agentId: string, atMs = Date.now()): void {
  const run = runs.get(agentId);
  if (!run || run.shellReady) return;
  run.shellReady = true;
  tel.count('clubhouse.agent.time_to_shell_ready', (atMs - run.startMs) / 1000, [ATTR.orchestrator(run.orchestrator)]);
}

/** Hot path: called for every output chunk. One Map lookup and an add. */
export function agentOutput(agentId: string, bytes: number, atMs?: number): void {
  const run = runs.get(agentId);
  if (!run) return;
  run.bytes += bytes;
  if (run.firstOutput) return;
  run.firstOutput = true;
  tel.count('clubhouse.agent.time_to_first_output', ((atMs ?? Date.now()) - run.startMs) / 1000, base(run));
}

/**
 * A kill reached `stage`. Stages only move forward. The first stage a kill
 * starts at (exit command for PTY, SIGTERM for headless) is not an
 * escalation; only later stages are counted.
 */
export function agentKillStage(agentId: string, stage: KillStage): void {
  const run = runs.get(agentId);
  if (!run) return;
  const previous = run.killStage;
  if (previous && KILL_ORDER.indexOf(stage) <= KILL_ORDER.indexOf(previous)) return;
  run.killStage = stage;
  if (previous) tel.count('clubhouse.agent.kill.escalations', 1, [ATTR.killStage(stage)]);
}

/**
 * End a run whose session was removed without an exit broadcast (a hard
 * kill, or quit). The run is classified as a user kill at `stage`.
 */
export function agentRunKilled(agentId: string, stage: KillStage, atMs = Date.now()): void {
  const run = runs.get(agentId);
  if (!run) return;
  if (!run.killStage || KILL_ORDER.indexOf(stage) > KILL_ORDER.indexOf(run.killStage)) run.killStage = stage;
  endRun(agentId, null, 'killed_user', atMs);
}

/** The stale sweeper removed this run's process. */
export function agentSwept(agentId: string): void {
  const run = runs.get(agentId);
  if (run) run.swept = true;
}

/** Classify an exit. Exported for tests. */
export function classifyExit(run: Pick<Run, 'killStage' | 'swept' | 'startMs'>, exitCode: number | null, atMs: number): ExitClass {
  if (run.swept) return 'stale_swept';
  if (run.killStage === 'sigkill') return 'killed_escalated';
  if (run.killStage) return 'killed_user';
  if (exitCode === 0) return 'completed';
  if (atMs - run.startMs < EARLY_FAILURE_MS) return 'early_failure';
  return 'failed';
}

function endRun(agentId: string, exitCode: number | null, forced: ExitClass | null, atMs = Date.now()): void {
  const run = runs.get(agentId);
  if (!run) return;
  runs.delete(agentId);
  const exitClass = forced ?? classifyExit(run, exitCode, atMs);
  const attrs = [...base(run), ATTR.agentExitClass(exitClass)];
  if (run.kind) attrs.push(ATTR.agentKind(run.kind));
  const spanAttrs = [...attrs];
  if (exitCode !== null) spanAttrs.push(ATTR.exitCode(exitCode));
  if (run.killStage) spanAttrs.push(ATTR.killStage(run.killStage));
  const failed = exitClass === 'failed' || exitClass === 'early_failure';
  replaySpan({
    name: 'clubhouse.agent.run',
    startMs: run.startMs,
    endMs: atMs,
    attrs: spanAttrs,
    outcome: failed ? 'error' : exitClass === 'completed' ? 'ok' : 'cancelled',
    errorType: failed ? 'unknown' : undefined,
  });
  tel.count('clubhouse.agent.runs', 1, attrs);
  tel.count('clubhouse.agent.run.duration', (atMs - run.startMs) / 1000, attrs);
  if (run.bytes > 0) tel.count('clubhouse.pty.output.bytes', run.bytes, base(run));
  if (run.kill) {
    const killAttrs = [...base(run), ATTR.killTrigger(run.kill.trigger), ATTR.agentExitClass(exitClass)];
    if (run.killStage) killAttrs.push(ATTR.killStage(run.killStage));
    replaySpan({
      name: 'clubhouse.agent.kill',
      startMs: run.kill.startMs,
      endMs: Math.max(atMs, run.kill.startMs),
      attrs: killAttrs,
      outcome: 'ok',
    });
  }
}

// --- Wiring ---------------------------------------------------------------------

let installed = false;

/** Subscribe to agent exits. Call once at startup. */
export function installAgentTelemetry(getOrchestrator: (agentId: string) => string | undefined): void {
  lookupOrchestrator = getOrchestrator;
  if (installed) return;
  installed = true;
  onAgentExit((agentId, exitCode) => {
    endRun(agentId, exitCode, null);
    clearToolCalls(agentId);
  });
}

/** Test-only reset. */
export function _resetAgentTelemetryForTests(): void {
  runs.clear();
  pendingKinds.clear();
  installed = false;
  lookupOrchestrator = () => undefined;
}

/** Test-only: active run count. */
export function _activeRunsForTests(): number {
  return runs.size;
}
