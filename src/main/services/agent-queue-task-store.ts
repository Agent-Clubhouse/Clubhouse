/**
 * AgentQueueTaskStore — file-based persistent store for agent queue tasks.
 *
 * Storage layout:
 *   ~/.clubhouse/agent-queues/<queueId>/tasks/<taskId>/state.json
 *
 * Each task's state.json contains the full AgentQueueTask object.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { AgentQueueTask, AgentQueueTaskSummary, AgentQueueTaskStatus } from '../../shared/agent-queue-types';
import { appLog } from './log-service';

function agentQueuesDir(): string {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  return path.join(app.getPath('home'), dirName, 'agent-queues');
}

function taskDir(queueId: string, taskId: string): string {
  return path.join(agentQueuesDir(), queueId, 'tasks', taskId);
}

function statePath(queueId: string, taskId: string): string {
  return path.join(taskDir(queueId, taskId), 'state.json');
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

type TaskChangeListener = (queueId: string, taskId: string) => void;

class AgentQueueTaskStore {
  /** In-memory cache: queueId -> taskId -> task */
  private tasks = new Map<string, Map<string, AgentQueueTask>>();
  private listeners = new Set<TaskChangeListener>();

  /** Create a new task and persist it. */
  async createTask(queueId: string, mission: string): Promise<AgentQueueTask> {
    const taskId = `aqt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const task: AgentQueueTask = {
      id: taskId,
      queueId,
      mission,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    let queueTasks = this.tasks.get(queueId);
    if (!queueTasks) {
      queueTasks = new Map();
      this.tasks.set(queueId, queueTasks);
    }
    queueTasks.set(taskId, task);

    await this.persistTask(task);
    this.notifyListeners(queueId, taskId);
    return task;
  }

  /** Update task fields and persist. */
  async updateTask(
    queueId: string,
    taskId: string,
    fields: Partial<Pick<AgentQueueTask,
      'status' | 'agentId' | 'agentName' | 'worktreePath' | 'startedAt' | 'completedAt' |
      'exitCode' | 'costUsd' | 'durationMs' | 'filesModified' | 'summary' | 'detail' | 'errorMessage'
    >>,
  ): Promise<AgentQueueTask | null> {
    const task = await this.getTask(queueId, taskId);
    if (!task) return null;

    Object.assign(task, fields);
    await this.persistTask(task);
    this.notifyListeners(queueId, taskId);
    return task;
  }

  /** Get a single task by ID. */
  async getTask(queueId: string, taskId: string): Promise<AgentQueueTask | null> {
    // Check cache first
    const cached = this.tasks.get(queueId)?.get(taskId);
    if (cached) return cached;

    // Try loading from disk
    const sp = statePath(queueId, taskId);
    if (!(await pathExists(sp))) return null;

    try {
      const task: AgentQueueTask = JSON.parse(await fsp.readFile(sp, 'utf-8'));
      let queueTasks = this.tasks.get(queueId);
      if (!queueTasks) {
        queueTasks = new Map();
        this.tasks.set(queueId, queueTasks);
      }
      queueTasks.set(taskId, task);
      return task;
    } catch (err) {
      appLog('core:agent-queue', 'error', 'Failed to read task state', {
        meta: { queueId, taskId, error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  /** List all tasks for a queue. */
  async listTasks(queueId: string): Promise<AgentQueueTask[]> {
    await this.loadQueueTasks(queueId);
    const queueTasks = this.tasks.get(queueId);
    if (!queueTasks) return [];
    return [...queueTasks.values()].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  /** List task summaries for a queue. */
  async listTaskSummaries(queueId: string): Promise<AgentQueueTaskSummary[]> {
    const tasks = await this.listTasks(queueId);
    return tasks.map((t) => ({
      id: t.id,
      queueId: t.queueId,
      mission: t.mission,
      status: t.status,
      agentName: t.agentName,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      exitCode: t.exitCode,
      hasOutput: !!(t.summary || t.detail),
    }));
  }

  /** Get count of tasks by status. */
  async getStatusCounts(queueId: string): Promise<Record<AgentQueueTaskStatus, number>> {
    const tasks = await this.listTasks(queueId);
    const counts: Record<AgentQueueTaskStatus, number> = {
      pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
    };
    for (const t of tasks) {
      counts[t.status]++;
    }
    return counts;
  }

  /** Cancel a pending task. Only pending tasks can be cancelled. */
  async cancelTask(queueId: string, taskId: string): Promise<boolean> {
    const task = await this.getTask(queueId, taskId);
    if (!task || task.status !== 'pending') return false;
    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();
    await this.persistTask(task);
    this.notifyListeners(queueId, taskId);
    return true;
  }

  /** Delete all tasks for a queue (used when deleting the queue). */
  async deleteQueueTasks(queueId: string): Promise<void> {
    this.tasks.delete(queueId);
    const dir = path.join(agentQueuesDir(), queueId, 'tasks');
    try {
      if (await pathExists(dir)) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    } catch {
      appLog('core:agent-queue', 'warn', 'Failed to remove task directory', { meta: { queueId, dir } });
    }
  }

  /** Register a change listener. Returns unsubscribe function. */
  onChange(listener: TaskChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notifyListeners(queueId: string, taskId: string): void {
    for (const fn of this.listeners) {
      try { fn(queueId, taskId); } catch { /* ignore */ }
    }
  }

  private async persistTask(task: AgentQueueTask): Promise<void> {
    const dir = taskDir(task.queueId, task.id);
    try {
      await ensureDir(dir);
      await fsp.writeFile(statePath(task.queueId, task.id), JSON.stringify(task, null, 2), 'utf-8');
    } catch (err) {
      appLog('core:agent-queue', 'error', 'Failed to persist task state', {
        meta: { queueId: task.queueId, taskId: task.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Load all tasks for a queue from disk into cache. */
  private async loadQueueTasks(queueId: string): Promise<void> {
    // If we already have an entry (even empty), skip scan
    if (this.tasks.has(queueId)) return;

    const tasksDir = path.join(agentQueuesDir(), queueId, 'tasks');
    if (!(await pathExists(tasksDir))) {
      this.tasks.set(queueId, new Map());
      return;
    }

    const queueTasks = new Map<string, AgentQueueTask>();
    try {
      const entries = await fsp.readdir(tasksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sp = path.join(tasksDir, entry.name, 'state.json');
        if (!(await pathExists(sp))) continue;
        try {
          const task: AgentQueueTask = JSON.parse(await fsp.readFile(sp, 'utf-8'));
          queueTasks.set(task.id, task);
        } catch {
          // Skip corrupt entries
        }
      }
    } catch {
      // Directory read failed — start with empty
    }
    this.tasks.set(queueId, queueTasks);
  }

  /** For testing: reset all state. */
  _resetForTesting(): void {
    this.tasks.clear();
    this.listeners.clear();
  }
}

export const agentQueueTaskStore = new AgentQueueTaskStore();
