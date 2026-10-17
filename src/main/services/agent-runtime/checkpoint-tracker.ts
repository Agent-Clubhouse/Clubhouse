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

const BUSY_STATES: ReadonlySet<ChatSessionState> = new Set(['starting', 'running', 'waiting_permission', 'waiting_input']);

const rootCache = new Map<string, string | null>();
/** Snapshots taken just before a prompt was sent, waiting for that turn's id. */
const pendingStart = new Map<string, Promise<string | undefined>>();
type OpenTurn = { root: string; sessionId: string; turnId: string; start?: string };
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

/** Mark a turn as shared with another agent. The ref points at the turn's start checkpoint. */
async function markShared(root: string, agentId: string, turn: OpenTurn | undefined): Promise<void> {
  if (!turn?.start) return;
  await pointRef(root, checkpointRef(agentId, turn.sessionId, turn.turnId, 'shared'), turn.start);
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

/** Chat bus listener: checkpoint at turn boundaries. Failures are logged, never thrown. */
export function handleChatEventForCheckpoints(event: ChatEvent): void {
  if (event.type !== 'turn_started' && event.type !== 'turn_ended') return;
  if (!event.turnId) return;
  const phase = event.type === 'turn_started' ? 'start' : 'end';
  const { agentId, sessionId } = event;
  const turnId = event.turnId;
  // Close the turn as soon as it ends, so a revert right after isn't refused.
  const ending = phase === 'end' ? openTurns.get(agentId) : undefined;
  if (ending) openTurns.delete(agentId);
  void (async () => {
    const root = await rootFor(agentId);
    if (!root) return;
    try {
      const ref = checkpointRef(agentId, sessionId, turnId, phase);
      if (phase === 'start') {
        openTurns.set(agentId, { root, sessionId, turnId });
        const pending = pendingStart.get(agentId);
        if (pending) pendingStart.delete(agentId);
        const prepared = pending ? await pending : undefined;
        let start: string;
        if (prepared) {
          await pointRef(root, ref, prepared);
          await deleteRef(root, pendingRef(agentId));
          start = prepared;
        } else {
          start = await createCheckpoint(root, ref, `Clubhouse checkpoint: start of turn ${turnId}`);
        }
        const open = openTurns.get(agentId);
        if (open?.turnId === turnId) open.start = start;
      } else {
        await createCheckpoint(root, ref, `Clubhouse checkpoint: end of turn ${turnId}`);
      }
      const others = await neighbours(agentId, root);
      if (others.length) {
        await markShared(root, agentId, phase === 'end' ? ending : openTurns.get(agentId));
        for (const other of others) await markShared(root, other, openTurns.get(other));
      }
      if (phase === 'end') await pruneCheckpoints(root, agentId, CHECKPOINT_TURNS_KEPT);
    } catch (err) {
      warn('Checkpoint failed', { agentId, turnId, phase }, err);
    }
  })();
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
  const skipped = [...new Set([...await readSkipped(root, from), ...(to ? await readSkipped(root, to) : [])])];
  return {
    available: true,
    files,
    ...(patch !== undefined ? { patch } : {}),
    ...(skipped.length ? { skippedLarge: skipped } : {}),
    live: to === undefined,
  };
}

/** Refuse while this agent, or another chat agent in the same worktree, is mid-turn. */
async function assertQuiet(agentId: string, root: string): Promise<void> {
  const runtime = getAgentRuntime(agentId);
  if (openTurns.has(agentId) || (runtime?.kind === 'chat' && BUSY_STATES.has(runtime.getState()))) {
    throw new Error('Wait for the agent to finish its turn before changing its files');
  }
  for (const [id, turn] of openTurns) {
    if (id !== agentId && turn.root === root) throw new Error('Another agent is mid-turn in this worktree; try again when it finishes');
  }
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
  const { before, after, ...result } = await revertChanges(root, turn.start, turn.end, {
    force,
    backupRefs: {
      before: checkpointRef(agentId, turn.sessionId, turnId, 'pre-revert'),
      after: checkpointRef(agentId, turn.sessionId, turnId, 'post-revert'),
    },
  });
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
  const result = await revertChanges(root, turn.preRevert, turn.postRevert);
  if (!result.conflicts.length && !result.skipped.length) {
    await deleteRef(root, checkpointRef(agentId, turn.sessionId, turnId, 'pre-revert'));
    await deleteRef(root, checkpointRef(agentId, turn.sessionId, turnId, 'post-revert'));
  }
  appLog('core:chat', 'info', 'Undid revert', {
    meta: { agentId, turnId, restored: result.reverted.length, conflicts: result.conflicts.length, skipped: result.skipped.length },
  });
  return { reverted: result.reverted, conflicts: result.conflicts, skipped: result.skipped, undoable: !!(result.conflicts.length || result.skipped.length) };
}

/** For tests. */
export function clearCheckpointCaches(): void {
  rootCache.clear();
  pendingStart.clear();
  openTurns.clear();
}
