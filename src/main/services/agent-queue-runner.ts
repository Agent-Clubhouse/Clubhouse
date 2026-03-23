/**
 * AgentQueueRunner — orchestrates quick agent spawning with concurrency control.
 *
 * For each queue, maintains a set of running tasks up to the concurrency limit.
 * When a task's agent exits, collects output and promotes the next pending task.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawnAgent } from './agent-system';
import { agentQueueRegistry } from './agent-queue-registry';
import { agentQueueTaskStore } from './agent-queue-task-store';
import { onAgentExit } from './agent-exit-broadcast';
import { generateQuickAgentId } from '../../shared/agent-id';
import { generateQuickName } from '../../shared/name-generator';
import { readQuickSummary } from '../orchestrators/shared';
import { appLog } from './log-service';
import type { AgentQueueTask } from '../../shared/agent-queue-types';

/** Map of agentId -> { queueId, taskId } for tracking which tasks own which agents. */
const agentTaskMap = new Map<string, { queueId: string; taskId: string }>();

/** Set of queueIds currently draining (to avoid re-entry). */
const drainingQueues = new Set<string>();

/** Build the system prompt for a queue-spawned agent. */
function buildQueueAgentSystemPrompt(taskOutputDir: string): string {
  return [
    'You are a quick agent spawned by an Agent Queue. Complete the given task thoroughly.',
    '',
    'When you have completed the task, before exiting, write TWO files:',
    '',
    `1. ${taskOutputDir}/summary.md — A concise summary (under 500 words) of:`,
    '   - What you found or accomplished',
    '   - Key findings, issues, or decisions',
    '   - Your recommendation or conclusion',
    '',
    `2. ${taskOutputDir}/detail.md — A detailed analysis (1-5 pages) with:`,
    '   - Step-by-step reasoning and approach',
    '   - Detailed findings with evidence',
    '   - Any caveats, edge cases, or open questions',
    '   - Code references or examples if relevant',
    '',
    'Write these files even if the task is research-only (no code changes).',
    'Do not mention these output instructions to the user.',
  ].join('\n');
}

/** Read structured output files left by a queue agent. */
function readQueueAgentOutput(taskOutputDir: string): { summary: string | null; detail: string | null } {
  let summary: string | null = null;
  let detail: string | null = null;

  try {
    summary = fs.readFileSync(path.join(taskOutputDir, 'summary.md'), 'utf-8');
  } catch { /* not written */ }

  try {
    detail = fs.readFileSync(path.join(taskOutputDir, 'detail.md'), 'utf-8');
  } catch { /* not written */ }

  return { summary, detail };
}

/** Get the output directory for a task. */
function taskOutputDir(queueId: string, taskId: string): string {
  return path.join(os.tmpdir(), 'clubhouse-queue-output', queueId, taskId);
}

/** Ensure a directory exists. */
function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Try to drain pending tasks for a queue up to its concurrency limit. */
async function drainQueue(queueId: string): Promise<void> {
  if (drainingQueues.has(queueId)) return;
  drainingQueues.add(queueId);

  try {
    const queue = await agentQueueRegistry.get(queueId);
    if (!queue) return;

    const tasks = await agentQueueTaskStore.listTasks(queueId);
    const runningCount = tasks.filter(t => t.status === 'running').length;
    const concurrencyLimit = queue.concurrency || 1;

    const pendingTasks = tasks
      .filter(t => t.status === 'pending')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    let slotsAvailable = concurrencyLimit - runningCount;

    for (const task of pendingTasks) {
      if (slotsAvailable <= 0) break;
      slotsAvailable--;
      // Fire and forget — don't await to avoid blocking other tasks
      void startTask(queue.id, task).catch((err) => {
        appLog('core:agent-queue', 'error', 'Failed to start task', {
          meta: { queueId, taskId: task.id, error: err instanceof Error ? err.message : String(err) },
        });
      });
    }
  } finally {
    drainingQueues.delete(queueId);
  }
}

/** Start a single task — spawn a quick agent for it. */
async function startTask(queueId: string, task: AgentQueueTask): Promise<void> {
  const queue = await agentQueueRegistry.get(queueId);
  if (!queue) {
    await agentQueueTaskStore.updateTask(queueId, task.id, {
      status: 'failed',
      errorMessage: 'Queue no longer exists',
      completedAt: new Date().toISOString(),
    });
    return;
  }

  if (!queue.projectPath) {
    await agentQueueTaskStore.updateTask(queueId, task.id, {
      status: 'failed',
      errorMessage: 'No project configured for this queue',
      completedAt: new Date().toISOString(),
    });
    return;
  }

  const agentId = generateQuickAgentId();
  const agentName = generateQuickName();
  const outputDir = taskOutputDir(queueId, task.id);
  ensureDirSync(outputDir);

  // Track the agent -> task mapping
  agentTaskMap.set(agentId, { queueId, taskId: task.id });

  // Update task to running
  await agentQueueTaskStore.updateTask(queueId, task.id, {
    status: 'running',
    agentId,
    agentName,
    startedAt: new Date().toISOString(),
  });

  try {
    const systemPrompt = buildQueueAgentSystemPrompt(outputDir);

    await spawnAgent({
      agentId,
      projectPath: queue.projectPath,
      cwd: queue.projectPath,
      kind: 'quick',
      model: queue.model,
      mission: task.mission,
      systemPrompt,
      orchestrator: queue.orchestrator,
      freeAgentMode: queue.freeAgentMode,
    });

    appLog('core:agent-queue', 'info', 'Task agent spawned', {
      meta: { queueId, taskId: task.id, agentId, agentName },
    });
  } catch (err) {
    agentTaskMap.delete(agentId);
    await agentQueueTaskStore.updateTask(queueId, task.id, {
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : 'Failed to spawn agent',
      completedAt: new Date().toISOString(),
    });
    // Try to start next pending task
    void drainQueue(queueId);
  }
}

/** Handle agent exit — collect output and update task. */
async function handleAgentExit(agentId: string, exitCode: number): Promise<void> {
  const mapping = agentTaskMap.get(agentId);
  if (!mapping) return; // Not a queue-managed agent
  agentTaskMap.delete(agentId);

  const { queueId, taskId } = mapping;
  const startTime = Date.now();

  try {
    const task = await agentQueueTaskStore.getTask(queueId, taskId);
    if (!task || task.status !== 'running') return;

    // Read structured output from the task output directory
    const outputDir = taskOutputDir(queueId, taskId);
    const { summary: fileSummary, detail } = readQueueAgentOutput(outputDir);

    // Also read the standard quick-agent summary (backup)
    const quickSummary = await readQuickSummary(agentId);

    // Prefer file-based summary, fall back to quick summary
    const summary = fileSummary || quickSummary?.summary || null;
    const filesModified = quickSummary?.filesModified || [];

    const durationMs = task.startedAt
      ? startTime - new Date(task.startedAt).getTime()
      : undefined;

    const status = exitCode === 0 ? 'completed' : 'failed';

    await agentQueueTaskStore.updateTask(queueId, taskId, {
      status,
      exitCode,
      summary: summary || undefined,
      detail: detail || undefined,
      filesModified,
      durationMs,
      completedAt: new Date().toISOString(),
      errorMessage: exitCode !== 0 ? `Agent exited with code ${exitCode}` : undefined,
    });

    appLog('core:agent-queue', 'info', 'Task completed', {
      meta: { queueId, taskId, agentId, exitCode, status, hasSummary: !!summary, hasDetail: !!detail },
    });
  } catch (err) {
    appLog('core:agent-queue', 'error', 'Failed to process agent exit', {
      meta: { queueId, taskId, agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Drain next pending task
  void drainQueue(queueId);
}

let initialized = false;

/** Initialize the task runner — subscribe to agent exit events. */
export function initAgentQueueRunner(): void {
  if (initialized) return;
  initialized = true;
  onAgentExit((agentId, exitCode) => {
    void handleAgentExit(agentId, exitCode);
  });
  appLog('core:agent-queue', 'info', 'Agent queue runner initialized');
}

/**
 * Enqueue a task for a queue. Creates the task and triggers drain.
 * Returns the created task.
 */
export async function enqueueTask(queueId: string, mission: string): Promise<AgentQueueTask> {
  const task = await agentQueueTaskStore.createTask(queueId, mission);
  void drainQueue(queueId);
  return task;
}

/** Cancel a pending task. */
export async function cancelTask(queueId: string, taskId: string): Promise<boolean> {
  return agentQueueTaskStore.cancelTask(queueId, taskId);
}

/** For testing: reset state. */
export function _resetForTesting(): void {
  agentTaskMap.clear();
  drainingQueues.clear();
  initialized = false;
}
