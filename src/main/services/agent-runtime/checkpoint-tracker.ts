/**
 * Takes a checkpoint at every chat turn start and end, and answers the
 * Changes panel's questions (what changed in a turn or session, revert a
 * turn). The refs are the source of truth, so history survives restarts.
 */

import type { ChatEvent } from '../../../shared/chat';
import type { CheckpointTurn, ChangesResult } from '../../../shared/chat-checkpoints';
export type { CheckpointTurn, ChangesResult };
import { agentRegistry } from '../agent-registry';
import { appLog } from '../log-service';
import {
  pointRef,
  checkpointRef,
  createCheckpoint,
  diffFiles,
  diffPatch,
  isGitWorkTree,
  listCheckpointRefs,
  pruneCheckpoints,
  revertChanges,
  type RevertResult,
} from './checkpoints';

/** Turns of history kept per agent. */
export const CHECKPOINT_TURNS_KEPT = 50;

const gitWorkTreeCache = new Map<string, boolean>();
/** Snapshots taken just before a prompt was sent, waiting for that turn's id. */
const pendingStart = new Map<string, Promise<string | undefined>>();

async function cwdFor(agentId: string): Promise<string | undefined> {
  const reg = agentRegistry.get(agentId);
  const cwd = reg?.cwd ?? reg?.projectPath;
  if (!cwd) return undefined;
  if (!gitWorkTreeCache.has(cwd)) gitWorkTreeCache.set(cwd, await isGitWorkTree(cwd));
  return gitWorkTreeCache.get(cwd) ? cwd : undefined;
}

/**
 * Snapshot the working tree right before a prompt goes to the CLI, so the
 * turn's start checkpoint can't include the agent's first edits. The chat
 * runtime awaits this (bounded) before sending; turn_started then names it.
 */
export async function captureBeforePrompt(agentId: string): Promise<void> {
  const cwd = await cwdFor(agentId);
  if (!cwd) return;
  const snapshot = createCheckpoint(cwd, `refs/clubhouse/pending/${agentId.replace(/[^A-Za-z0-9._-]/g, '_')}`, 'Clubhouse checkpoint: before prompt')
    .catch((err): undefined => {
      appLog('core:chat', 'warn', 'Pre-prompt checkpoint failed', {
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
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
  const turnId = event.turnId;
  void (async () => {
    const cwd = await cwdFor(event.agentId);
    if (!cwd) return;
    try {
      const ref = checkpointRef(event.agentId, event.sessionId, turnId, phase);
      const pending = phase === 'start' ? pendingStart.get(event.agentId) : undefined;
      if (pending) pendingStart.delete(event.agentId);
      const prepared = pending ? await pending : undefined;
      if (prepared) await pointRef(cwd, ref, prepared);
      else await createCheckpoint(cwd, ref, `Clubhouse checkpoint: ${phase} of turn ${turnId}`);
      if (phase === 'end') await pruneCheckpoints(cwd, event.agentId, CHECKPOINT_TURNS_KEPT);
    } catch (err) {
      appLog('core:chat', 'warn', 'Checkpoint failed', {
        meta: { agentId: event.agentId, turnId, phase, error: err instanceof Error ? err.message : String(err) },
      });
    }
  })();
}

/** Turns with checkpoints, oldest first. */
export async function listTurns(agentId: string): Promise<CheckpointTurn[]> {
  const cwd = await cwdFor(agentId);
  if (!cwd) return [];
  const turns = new Map<string, CheckpointTurn>();
  for (const ref of await listCheckpointRefs(cwd, agentId)) {
    const key = `${ref.sessionId}/${ref.turnId}`;
    const turn = turns.get(key) ?? { sessionId: ref.sessionId, turnId: ref.turnId, startedAt: ref.createdAt, start: '' };
    if (ref.phase === 'start') {
      turn.start = ref.commit;
      turn.startedAt = ref.createdAt;
    } else {
      turn.end = ref.commit;
      turn.endedAt = ref.createdAt;
    }
    turns.set(key, turn);
  }
  return [...turns.values()].filter((t) => t.start);
}

export type ChangesScope = { turnId: string } | { sessionId: string };

/** What changed in a turn (start → end, or start → now while running) or a session (first start → now). */
export async function getChanges(agentId: string, scope: ChangesScope, filePath?: string): Promise<ChangesResult> {
  const cwd = await cwdFor(agentId);
  if (!cwd) return { available: false, files: [] };
  const turns = await listTurns(agentId);
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
  const files = await diffFiles(cwd, from, to);
  const patch = filePath ? await diffPatch(cwd, from, to, filePath) : undefined;
  return { available: true, files, ...(patch !== undefined ? { patch } : {}), live: to === undefined };
}

/** Revert a finished turn's changes. Files edited after the turn are skipped unless forced. */
export async function revertTurn(agentId: string, turnId: string, force = false): Promise<RevertResult> {
  const cwd = await cwdFor(agentId);
  if (!cwd) throw new Error('Checkpoints need a git repository');
  const turn = (await listTurns(agentId)).find((t) => t.turnId === turnId);
  if (!turn?.end) throw new Error('That turn has no end checkpoint yet; wait for it to finish');
  const result = await revertChanges(cwd, turn.start, turn.end, force);
  appLog('core:chat', 'info', 'Reverted turn', {
    meta: { agentId, turnId, reverted: result.reverted.length, conflicts: result.conflicts.length, force },
  });
  return result;
}

/** For tests. */
export function clearCheckpointCaches(): void {
  gitWorkTreeCache.clear();
  pendingStart.clear();
}
