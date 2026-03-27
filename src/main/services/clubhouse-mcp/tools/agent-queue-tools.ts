/**
 * Agent Queue MCP Tools — allows agents linked to an agent queue
 * to invoke tasks, poll output, and list task status.
 */

import { registerToolTemplate } from '../tool-registry';
import { agentQueueRegistry } from '../../agent-queue-registry';
import { agentQueueTaskStore } from '../../agent-queue-task-store';
import { enqueueTask, cancelTask } from '../../agent-queue-runner';
import type { McpToolResult } from '../types';

/** Register all agent-queue tool templates. */
export function registerAgentQueueTools(): void {
  // queue__<name>_<hash>__invoke
  registerToolTemplate(
    'agent-queue',
    'invoke',
    {
      description:
        'Submit a new task to this agent queue. A quick agent will be spawned to execute the mission.\n\n' +
        'Returns a task ID that you can use with get_output to poll for results.\n\n' +
        'The spawned agent will work on the task independently and produce:\n' +
        '- A summary (< 500 words): key findings, outcome, recommendations\n' +
        '- Detailed output (1-5 pages): full reasoning, analysis, evidence\n\n' +
        'Tasks are queued and run up to the configured concurrency limit.',
      inputSchema: {
        type: 'object',
        properties: {
          mission: {
            type: 'string',
            description: 'The task description / mission for the spawned agent.',
          },
        },
        required: ['mission'],
      },
    },
    async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const mission = args.mission as string;
      if (!mission) {
        return {
          content: [{ type: 'text', text: 'mission is required.' }],
          isError: true,
        };
      }

      const queue = await agentQueueRegistry.get(targetId);
      if (!queue) {
        return {
          content: [{ type: 'text', text: `Agent queue ${targetId} not found.` }],
          isError: true,
        };
      }

      try {
        const task = await enqueueTask(targetId, mission);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              taskId: task.id,
              status: task.status,
              queueName: queue.name,
              message: 'Task queued successfully. Use get_output with this taskId to poll for results.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to enqueue task: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // queue__<name>_<hash>__get_output
  registerToolTemplate(
    'agent-queue',
    'get_output',
    {
      description:
        'Get the current status and output for a task by ID.\n\n' +
        'Returns the task state, and if completed, the summary and detailed output.\n\n' +
        'Status values:\n' +
        '- "pending": waiting in queue for a concurrency slot\n' +
        '- "running": agent is actively working on the task\n' +
        '- "completed": agent finished successfully — output available\n' +
        '- "failed": agent errored — check errorMessage\n' +
        '- "cancelled": task was cancelled before execution\n\n' +
        'Poll this endpoint periodically (every 10-30 seconds) until status is terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID returned by invoke.',
          },
          include_detail: {
            type: 'boolean',
            description: 'Include the detailed output (default false — only summary is returned).',
          },
        },
        required: ['task_id'],
      },
    },
    async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const taskId = args.task_id as string;
      if (!taskId) {
        return {
          content: [{ type: 'text', text: 'task_id is required.' }],
          isError: true,
        };
      }

      const task = await agentQueueTaskStore.getTask(targetId, taskId);
      if (!task) {
        return {
          content: [{ type: 'text', text: `Task ${taskId} not found in queue ${targetId}.` }],
          isError: true,
        };
      }

      const includeDetail = args.include_detail === true;

      const result: Record<string, unknown> = {
        taskId: task.id,
        status: task.status,
        mission: task.mission,
        agentName: task.agentName,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        exitCode: task.exitCode,
        durationMs: task.durationMs,
        filesModified: task.filesModified,
        errorMessage: task.errorMessage,
      };

      if (task.summary) {
        result.summary = task.summary;
      }

      if (includeDetail && task.detail) {
        result.detail = task.detail;
      } else if (task.detail) {
        result.hasDetail = true;
        result.detailHint = 'Set include_detail=true to get the full detailed output.';
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // queue__<name>_<hash>__list
  registerToolTemplate(
    'agent-queue',
    'list',
    {
      description:
        'List all tasks in this agent queue with their current status.\n\n' +
        'Returns a JSON object with task summaries and status counts.\n' +
        'Use get_output with a specific task_id to get full output.',
      inputSchema: {
        type: 'object',
        properties: {
          status_filter: {
            type: 'string',
            description: 'Filter by status: "pending", "running", "completed", "failed", "cancelled". Omit for all.',
          },
        },
      },
    },
    async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const statusFilter = args.status_filter as string | undefined;

      let summaries = await agentQueueTaskStore.listTaskSummaries(targetId);
      if (statusFilter) {
        summaries = summaries.filter(t => t.status === statusFilter);
      }

      const counts = await agentQueueTaskStore.getStatusCounts(targetId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            counts,
            tasks: summaries,
          }, null, 2),
        }],
      };
    },
  );

  // queue__<name>_<hash>__cancel
  registerToolTemplate(
    'agent-queue',
    'cancel',
    {
      description:
        'Cancel a pending task. Only tasks with status "pending" can be cancelled.\n' +
        'Running tasks cannot be cancelled through this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID to cancel.',
          },
        },
        required: ['task_id'],
      },
    },
    async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const taskId = args.task_id as string;
      if (!taskId) {
        return {
          content: [{ type: 'text', text: 'task_id is required.' }],
          isError: true,
        };
      }

      const cancelled = await cancelTask(targetId, taskId);
      if (!cancelled) {
        return {
          content: [{ type: 'text', text: `Cannot cancel task ${taskId} — it may not be pending or may not exist.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ cancelled: true, taskId }) }],
      };
    },
  );

  // queue__<name>_<hash>__get_queue_info
  registerToolTemplate(
    'agent-queue',
    'get_queue_info',
    {
      description:
        'Get information about this agent queue including its configuration and current status counts.\n\n' +
        'Returns queue name, concurrency setting, project info, and task status breakdown.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async (targetId: string, _agentId: string, _args: Record<string, unknown>): Promise<McpToolResult> => {
      const queue = await agentQueueRegistry.get(targetId);
      if (!queue) {
        return {
          content: [{ type: 'text', text: `Agent queue ${targetId} not found.` }],
          isError: true,
        };
      }

      const counts = await agentQueueTaskStore.getStatusCounts(targetId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: queue.id,
            name: queue.name,
            concurrency: queue.concurrency,
            projectId: queue.projectId,
            model: queue.model,
            orchestrator: queue.orchestrator,
            autoWorktree: queue.autoWorktree,
            freeAgentMode: queue.freeAgentMode,
            taskCounts: counts,
          }, null, 2),
        }],
      };
    },
  );
}
