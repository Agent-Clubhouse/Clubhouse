/**
 * Takes a checkpoint at every chat turn start and end, and answers the
 * Changes panel's questions (what changed in a turn or session, revert or
 * un-revert a turn). The refs are the source of truth, so history survives
 * restarts.
 *
 * Checkpoints snapshot the whole repository, so when another agent works in
 * the same worktree during a turn its edits land in that turn too. The turn
 * is marked `shared` so the panel can warn before reverting it.
 */

import type { ChatEvent, ChatSessionState } from '../../../shared/chat';
import type { CheckpointTurn, ChangesResult, RevertResult } from '../../../shared/chat-checkpoints';
export type { CheckpointTurn, ChangesResult };
import { agentRegistry } from '../agent-registry';
import { appLog } from '../log-service';
import { getAgentRuntime } from './index';
import {
  pointRef,
  checkpointRef,
  createCheckpoint,
  deleteRef,
  diffFiles,
  diffPatch,
  listCheckpointRefs,
  pendingRef,
  pruneCheckpoints,
  readSkipped,
  repoRoot,
  revertChanges,
  type CheckpointRefInfo,
} from './checkpoints';

/** Turns of history kept per agent. */
export const CHECKPOINT_TURNS_KEPT = 50;

/** A chat agent in one of these is mid-turn. */
export const BUSY_STATES: ReadonlySet<ChatSessionState> = new Set(['starting', 'running', 'waiting_permission', 'waiting_input']);

const rootCache = new Map<string, string | null>();
/** Snapshots taken just before a prompt was sent, waiting for that turn's id. */
const pendingStart = new Map<string, Promise<string | undefined>>();
type OpenTurn = {
  sessionId: string;
  turnId: string;
  /** Set once the agent's repository root is known. */
  root?: string;
  /** The start checkpoint, once written; undefined if it couldn't be. */
  start?: Promise<string | undefined>;
};
/** Chat turns in progress, for spotting agents that share a worktree. */
const openTurns = new Map<string, OpenTurn>();

async function rootOf(cwd: string): Promise<string | undefined> {
  if (!rootCache.has(cwd)) rootCache.set(cwd, (await repoRoot(cwd)) ?? null);
  return rootCache.get(cwd) ?? undefined;
}

/** The agent's repository root; git paths are relative to it even when the agent runs in a subdirectory. */
async function rootFor(agentId: string): Promise<string | undefined> {
  const reg = agentRegistry.get(agentId);
  const cwd = reg?.cwd ?? reg?.projectPath;
  return cwd ? rootOf(cwd) : undefined;
}

/** Other agents working in `root` right now: chat agents mid-turn, and live terminal or headless agents. */
async function neighbours(agentId: string, root: string): Promise<string[]> {
  const out = new Set<string>();
  for (const [id, turn] of openTurns) if (id !== agentId && turn.root === root) out.add(id);
  for (const [id, reg] of agentRegistry.getAllRegistrations()) {
    if (id === agentId || out.has(id) || reg.runtime === 'chat') continue;
    if (reg.runtime === 'pty' && !getAgentRuntime(id)?.isRunning()) continue;
    const cwd = reg.cwd ?? reg.projectPath;
    if (cwd && (await rootOf(cwd)) === root) out.add(id);
  }
  return [...out];
}

function warn(message: string, meta: Record<string, unknown>, err: unknown): void {
  appLog('core:chat', 'warn', message, { meta: { ...meta, error: err instanceof Error ? err.message : String(err) } });
}

/**
 * Snapshot the working tree right before a prompt goes to the CLI, so the
 * turn's start checkpoint can't include the agent's first edits. The chat
 * runtime awaits this (bounded) before sending; turn_started then names it.
 * If the bound runs out, the snapshot finishes late and may fold the agent's
 * first edits into the start, so a revert leaves them alone rather than
 * touching anything it shouldn't.
 */
export async function captureBeforePrompt(agentId: string): Promise<void> {
  const root = await rootFor(agentId);
  if (!root) return;
  const snapshot = createCheckpoint(root, pendingRef(agentId), 'Clubhouse checkpoint: before prompt')
    .catch((err): undefined => {
      warn('Pre-prompt checkpoint failed', { agentId }, err);
      return undefined;
    });
  pendingStart.set(agentId, snapshot);
  await snapshot;
}

/** Mark a turn as shared with another agent. The ref points at the turn's start checkpoint. */
async function markShared(root: string, agentId: string, turn: OpenTurn | undefined): Promise<void> {
  const start = await turn?.start;
  if (!turn || !start) return;
  await pointRef(root, checkpointRef(agentId, turn.sessionId, turn.turnId, 'shared'), start);
}

/** Mark the agent's turn, and the open turns of agents beside it, as shared if anyone else works in `root`. */
async function markNeighbours(root: string, agentId: string, turn: OpenTurn | undefined): Promise<void> {
  const others = await neighbours(agentId, root);
  if (!others.length) return;
  await markShared(root, agentId, turn);
  for (const other of others) await markShared(root, other, openTurns.get(other));
}

/** Name the turn's start checkpoint: the pre-prompt snapshot if there is one, else a fresh one. */
async function startCheckpoint(agentId: string, turn: OpenTurn): Promise<string | undefined> {
  const root = await rootFor(agentId);
  if (!root) return undefined;
  turn.root = root;
  const ref = checkpointRef(agentId, turn.sessionId, turn.turnId, 'start');
  try {
    const pending = pendingStart.get(agentId);
    if (pending) pendingStart.delete(agentId);
    const prepared = pending ? await pending : undefined;
    if (!prepared) return await createCheckpoint(root, ref, `Clubhouse checkpoint: start of turn ${turn.turnId}`);
    await pointRef(root, ref, prepared);
    await deleteRef(root, pendingRef(agentId));
    return prepared;
  } catch (err) { // telemetry-exempt: logged; a missing checkpoint only costs Changes-panel history
    warn('Checkpoint failed', { agentId, turnId: turn.turnId, phase: 'start' }, err);
    return undefined;
  }
}

/**
 * Chat bus listener: checkpoint at turn boundaries. Failures are logged, never thrown.
 *
 * The open turn is recorded before anything is awaited, so a turn_ended that
 * arrives while the start checkpoint is still being written finds it, waits
 * for it, and closes it.
 */
export function handleChatEventForCheckpoints(event: ChatEvent): void {
  if (event.type !== 'turn_started' && event.type !== 'turn_ended') return;
  if (!event.turnId) return;
  const { agentId, sessionId } = event;
  const turnId = event.turnId;
  if (event.type === 'turn_started') {
    const turn: OpenTurn = { sessionId, turnId };
    turn.start = startCheckpoint(agentId, turn);
    openTurns.set(agentId, turn);
    track((async () => {
      if (!(await turn.start) || !turn.root) return;
      try {
        await markNeighbours(turn.root, agentId, turn);
      } catch (err) { // telemetry-exempt: logged; a missing shared mark only drops the revert warning
        warn('Checkpoint failed', { agentId, turnId, phase: 'start' }, err);
      }
    })());
    return;
  }
  // Close the turn as soon as it ends, so a revert right after isn't refused.
  const ending = openTurns.get(agentId);
  if (ending) openTurns.delete(agentId);
  track((async () => {
    // The end checkpoint must not land before the start.
    await ending?.start;
    const root = await rootFor(agentId);
    if (!root) return;
    try {
      // Shared before end: once a turn has its end checkpoint, its shared mark is settled.
      await markNeighbours(root, agentId, ending);
      await createCheckpoint(root, checkpointRef(agentId, sessionId, turnId, 'end'), `Clubhouse checkpoint: end of turn ${turnId}`);
      await pruneCheckpoints(root, agentId, CHECKPOINT_TURNS_KEPT);
    } catch (err) { // telemetry-exempt: logged; a missing checkpoint only costs Changes-panel history
      warn('Checkpoint failed', { agentId, turnId, phase: 'end' }, err);
    }
  })());
}

interface TurnRefs extends CheckpointTurn {
  preRevert?: string;
  postRevert?: string;
}

async function turnRefs(root: string, agentId: string): Promise<TurnRefs[]> {
  const turns = new Map<string, TurnRefs>();
  for (const ref of await listCheckpointRefs(root, agentId)) {
    const key = `${ref.sessionId}/${ref.turnId}`;
    const turn = turns.get(key) ?? { sessionId: ref.sessionId, turnId: ref.turnId, startedAt: ref.createdAt, start: '' };
    applyRef(turn, ref);
    turns.set(key, turn);
  }
  return [...turns.values()].filter((t) => t.start);
}

function applyRef(turn: TurnRefs, ref: CheckpointRefInfo): void {
  switch (ref.phase) {
    case 'start': turn.start = ref.commit; turn.startedAt = ref.createdAt; break;
    case 'end': turn.end = ref.commit; turn.endedAt = ref.createdAt; break;
    case 'shared': turn.shared = true; break;
    case 'pre-revert': turn.preRevert = ref.commit; break;
    case 'post-revert': turn.postRevert = ref.commit; break;
  }
}

/** Turns with checkpoints, oldest first. */
export async function listTurns(agentId: string): Promise<CheckpointTurn[]> {
  const root = await rootFor(agentId);
  if (!root) return [];
  return (await turnRefs(root, agentId)).map(({ preRevert, postRevert, ...turn }) => ({
    ...turn,
    ...(preRevert && postRevert ? { undoable: true } : {}),
  }));
}

export type ChangesScope = { turnId: string } | { sessionId: string };

/** What changed in a turn (start → end, or start → now while running) or a session (first start → now). */
export async function getChanges(agentId: string, scope: ChangesScope, filePath?: string): Promise<ChangesResult> {
  const root = await rootFor(agentId);
  if (!root) return { available: false, files: [] };
  const turns = await turnRefs(root, agentId);
  let from: string | undefined;
  let to: string | undefined;
  if ('turnId' in scope) {
    const turn = turns.find((t) => t.turnId === scope.turnId);
    if (!turn) return { available: true, files: [] };
    from = turn.start;
    to = turn.end;
  } else {
    const first = turns.find((t) => t.sessionId === scope.sessionId);
    if (!first) return { available: true, files: [] };
    from = first.start;
    to = undefined;
  }
  const files = await diffFiles(root, from, to);
  const patch = filePath ? await diffPatch(root, from, to, filePath) : undefined;
  const notes = [await readSkipped(root, from), ...(to ? [await readSkipped(root, to)] : [])];
  const skipped = [...new Set(notes.flatMap((n) => n.large))];
  const repos = [...new Set(notes.flatMap((n) => n.repos))];
  return {
    available: true,
    files,
    ...(patch !== undefined ? { patch } : {}),
    ...(skipped.length ? { skippedLarge: skipped } : {}),
    ...(repos.length ? { skippedRepos: repos } : {}),
    live: to === undefined,
  };
}

/**
 * Refuse while this agent is mid-turn, or while any other agent works in the
 * same worktree: a chat agent mid-turn, or a live terminal or headless agent,
 * whose edits a revert could overwrite or be overwritten by.
 */
async function assertQuiet(agentId: string, root: string): Promise<void> {
  const runtime = getAgentRuntime(agentId);
  if (openTurns.has(agentId) || (runtime?.kind === 'chat' && BUSY_STATES.has(runtime.getState()))) {
    throw new Error('Wait for the agent to finish its turn before changing its files');
  }
  if ((await neighbours(agentId, root)).length) {
    throw new Error('Another agent is working in this worktree; try again when it finishes');
  }
}

/** Worktrees with a revert or undo in progress. */
const reverting = new Map<string, number>();

async function whileReverting<T>(root: string, fn: () => Promise<T>): Promise<T> {
  reverting.set(root, (reverting.get(root) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const n = (reverting.get(root) ?? 1) - 1;
    if (n) reverting.set(root, n);
    else reverting.delete(root);
  }
}

/**
 * True while a revert is changing this agent's worktree. New user prompts are
 * refused meanwhile; other prompts wait behind it anyway, because the
 * pre-prompt snapshot queues after the revert on the repository.
 */
export async function isRevertRunning(agentId: string): Promise<boolean> {
  const root = await rootFor(agentId);
  return !!root && reverting.has(root);
}

async function findTurn(agentId: string, turnId: string): Promise<{ root: string; turn: TurnRefs }> {
  const root = await rootFor(agentId);
  if (!root) throw new Error('Checkpoints need a git repository');
  const turn = (await turnRefs(root, agentId)).find((t) => t.turnId === turnId);
  if (!turn) throw new Error('No checkpoints for that turn');
  return { root, turn };
}

/**
 * Revert a finished turn's changes. Files edited after the turn are skipped
 * unless forced; either way the current tree is backed up first so the
 * revert can be undone.
 */
export async function revertTurn(agentId: string, turnId: string, force = false): Promise<RevertResult> {
  const { root, turn } = await findTurn(agentId, turnId);
  if (!turn.end) throw new Error('That turn has no end checkpoint yet; wait for it to finish');
  await assertQuiet(agentId, root);
  const { before, after, ...result } = await whileReverting(root, () => revertChanges(root, turn.start, turn.end, {
    force,
    backupRefs: {
      before: checkpointRef(agentId, turn.sessionId, turnId, 'pre-revert'),
      after: checkpointRef(agentId, turn.sessionId, turnId, 'post-revert'),
    },
  }));
  appLog('core:chat', 'info', 'Reverted turn', {
    meta: { agentId, turnId, reverted: result.reverted.length, conflicts: result.conflicts.length, skipped: result.skipped.length, force, backup: before, after },
  });
  return { ...result, undoable: result.reverted.length > 0 || !!turn.preRevert };
}

/** Put back what the last revert of a turn changed. Files edited since the revert are left alone. */
export async function undoRevert(agentId: string, turnId: string): Promise<RevertResult> {
  const { root, turn } = await findTurn(agentId, turnId);
  if (!turn.preRevert || !turn.postRevert) throw new Error('Nothing to undo for that turn');
  await assertQuiet(agentId, root);
  // Same operation as a revert: restore the backup, refusing files changed since the post-revert tree.
  const { preRevert, postRevert } = turn;
  const result = await whileReverting(root, () => revertChanges(root, preRevert, postRevert));
  if (!result.conflicts.length && !result.skipped.length) {
    await deleteRef(root, checkpointRef(agentId, turn.sessionId, turnId, 'pre-revert'));
    await deleteRef(root, checkpointRef(agentId, turn.sessionId, turnId, 'post-revert'));
  }
  appLog('core:chat', 'info', 'Undid revert', {
    meta: { agentId, turnId, restored: result.reverted.length, conflicts: result.conflicts.length, skipped: result.skipped.length },
  });
  return { reverted: result.reverted, conflicts: result.conflicts, skipped: result.skipped, undoable: !!(result.conflicts.length || result.skipped.length) };
}

/** Background checkpoint work started by chat events. */
const inFlight = new Set<Promise<void>>();
function track(work: Promise<void>): void {
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
}

/** Resolves once background checkpoint work has finished. For tests and shutdown. */
export async function whenCheckpointsIdle(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** For tests. */
export function clearCheckpointCaches(): void {
  rootCache.clear();
  pendingStart.clear();
  openTurns.clear();
  reverting.clear();
}
