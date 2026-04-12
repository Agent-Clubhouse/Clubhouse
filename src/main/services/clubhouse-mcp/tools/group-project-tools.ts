/**
 * Group Project MCP Tools — allows agents linked to a group project
 * to coordinate via a shared bulletin board.
 */

import { bindingManager } from '../binding-manager';
import { mcpAdapter } from '../mcp-adapter';
import { getBulletinBoard } from '../../group-project-bulletin';
import { groupProjectRegistry } from '../../group-project-registry';
import { isAgentAlive, injectPtyMessage } from '../../group-project-lifecycle';
import { executeShoulderTap } from '../../group-project-shoulder-tap';
import { spawnAgent } from '../../agent-system';
import { listDurable } from '../../agent-config';
import * as projectStore from '../../project-store';
import { getAgentOrchestrator } from '../../agent-registry';
import { pollingStartMsg, pollingStopMsg } from '../../../../shared/polling-messages';
import * as annexEventBus from '../../annex-event-bus';
import { appLog } from '../../log-service';
import type { McpToolResult } from '../types';
import { requireString, optionalString, optionalNumber } from './validation';

/** Resolve agent status for a member entry. */
function resolveAgentStatus(agentId: string): 'connected' | 'sleeping' {
  return isAgentAlive(agentId) ? 'connected' : 'sleeping';
}

/**
 * Resolve sender identity for a group-project tool call, performing a live
 * registry lookup to catch renamed projects. Falls back to the cached
 * binding.projectName if the registry is unavailable. Writes back a refreshed
 * name to the binding so the renderer sees the update via BINDINGS_CHANGED.
 */
async function resolveSenderLabel(agentId: string, targetId: string): Promise<string> {
  const agentBindings = bindingManager.getBindingsForAgent(agentId);
  const binding = agentBindings.find(b => b.targetId === targetId && b.targetKind === 'group-project');

  let projectName = binding?.projectName;
  if (binding?.targetId) {
    try {
      const project = await groupProjectRegistry.get(binding.targetId);
      if (project?.name) {
        if (project.name !== binding.projectName) {
          bindingManager.updateBinding(agentId, binding.targetId, { projectName: project.name });
        }
        projectName = project.name;
      }
    } catch {
      // use cached fallback
    }
  }

  return binding?.agentName
    ? `${binding.agentName}${projectName ? '@' + projectName : ''}`
    : agentId;
}

/** Register all group-project tool templates. */
export function registerGroupProjectTools(): void {
  // group__<name>_<hash>__list_members
  mcpAdapter.registerMcpCommand({
    id: 'group-project.list_members',
    category: 'group-project',
    label: 'List Members',
    mcp: { targetKind: 'group-project', nameSuffix: 'list_members' },
    description:
        'List all agents currently connected to this group project.\n\n' +
        'Returns a JSON array of { agentId, agentName, status } objects. Use this to discover ' +
        'who is collaborating with you in this group project.\n\n' +
        'Status values:\n' +
        '- "connected": agent has a live process and is actively participating\n' +
        '- "sleeping": agent is bound but has no live process (exited or sleeping)\n\n' +
        'For full project context including instructions, use get_project_info.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    handler: async (targetId: string, _agentId: string, _args: Record<string, unknown>): Promise<McpToolResult> => {
      // Find all bindings where targetKind is group-project and targetId matches
      const allBindings = bindingManager.getAllBindings();
      const members = allBindings
        .filter(b => b.targetKind === 'group-project' && b.targetId === targetId)
        .map(b => ({
          agentId: b.agentId,
          agentName: b.agentName || b.agentId,
          status: resolveAgentStatus(b.agentId),
        }));

      return {
        content: [{ type: 'text', text: JSON.stringify(members) }],
      };
    },
  });

  // group__<name>_<hash>__post_bulletin
  mcpAdapter.registerMcpCommand({
    id: 'group-project.post_bulletin',
    category: 'group-project',
    label: 'Post Bulletin',
    mcp: { targetKind: 'group-project', nameSuffix: 'post_bulletin' },
    description:
        'Post a message to the group project bulletin board.\n\n' +
        'The bulletin board is the PRIMARY communication channel for group coordination. ' +
        'Post regular progress updates, questions, decisions, and status changes.\n\n' +
        'Your identity is automatically included as the sender. The "system" topic is ' +
        'reserved for lifecycle events — use any other topic name freely.\n\n' +
        'TOPIC HYGIENE: Use specific, distinct topic names to keep conversations organized. ' +
        'Suggested topics: "progress", "questions", "decisions", "blockers". Avoid dumping ' +
        'everything into a single topic — separate concerns make it easier to find and poll.\n\n' +
        'Keep messages concise. Prefer plain text or short markdown over large JSON payloads.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Topic name (freeform). "system" is reserved.',
          },
          body: {
            type: 'string',
            description: 'Message body (up to ~100KB).',
          },
        },
        required: ['topic', 'body'],
      },
    handler: async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = requireString(args, 'topic');
      const body = requireString(args, 'body');

      if (!topic || !body) {
        return {
          content: [{ type: 'text', text: 'Both topic and body are required.' }],
          isError: true,
        };
      }

      if (topic === 'system') {
        return {
          content: [{ type: 'text', text: 'The "system" topic is reserved for lifecycle events.' }],
          isError: true,
        };
      }

      const sender = await resolveSenderLabel(agentId, targetId);

      try {
        const board = getBulletinBoard(targetId);
        const msg = await board.postMessage(sender, topic, body);
        annexEventBus.emitBulletinMessage(targetId, msg);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ posted: true, messageId: msg.id, topic: msg.topic, timestamp: msg.timestamp }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to post: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });

  // group__<name>_<hash>__read_bulletin
  mcpAdapter.registerMcpCommand({
    id: 'group-project.read_bulletin',
    category: 'group-project',
    label: 'Read Bulletin',
    mcp: { targetKind: 'group-project', nameSuffix: 'read_bulletin' },
      description:
        'Read the bulletin board digest — shows all topics with message counts.\n\n' +
        'This is the key coordination primitive. When you see topics with newMessageCount > 0, ' +
        'use read_topic to get those new messages.\n\n' +
        'IMPORTANT: Always pass the "since" parameter with the latestTimestamp from your last ' +
        'read. This dramatically reduces response size and token cost. Only omit "since" on ' +
        'your very first read.\n\n' +
        'Returns a compact JSON array of {topic, messageCount, newMessageCount, latestTimestamp}.\n\n' +
        'Always check the "system" topic for join/leave lifecycle events.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. If provided, newMessageCount reflects only messages after this time.',
          },
        },
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const since = optionalString(args, 'since');
      const board = getBulletinBoard(targetId);
      const digest = await board.getDigest(since);
      return {
        content: [{ type: 'text', text: JSON.stringify(digest) }],
      };
    },
  });

  // group__<name>_<hash>__read_topic
  mcpAdapter.registerMcpCommand({
    id: 'group-project.read_topic',
    category: 'group-project',
    label: 'Read Topic',
    mcp: { targetKind: 'group-project', nameSuffix: 'read_topic' },
      description:
        'Read messages from a specific bulletin board topic.\n\n' +
        'IMPORTANT: Always pass the "since" parameter with the timestamp from your last ' +
        'read to only fetch new messages. This saves significant tokens.\n\n' +
        'Use summary=true to get truncated message bodies (~200 chars). If you need the ' +
        'full content of a specific message, use read_message with its ID.\n\n' +
        'Returns a compact JSON array of {id, sender, topic, body, timestamp}.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Topic name to read.',
          },
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. Only return messages after this time.',
          },
          limit: {
            type: 'number',
            description: 'Max messages to return (default 50).',
          },
          summary: {
            type: 'boolean',
            description: 'If true, truncate message bodies to ~200 chars. Use read_message to get the full body of specific messages.',
          },
        },
        required: ['topic'],
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = requireString(args, 'topic');
      if (!topic) {
        return {
          content: [{ type: 'text', text: 'topic is required.' }],
          isError: true,
        };
      }
      const since = optionalString(args, 'since');
      const limit = optionalNumber(args, 'limit');
      const summary = args.summary === true;
      const board = getBulletinBoard(targetId);
      const messages = await board.getTopicMessages(topic, since, limit);

      if (summary) {
        const summarized = messages.map(m => ({
          id: m.id,
          sender: m.sender,
          topic: m.topic,
          body: m.body.length > 200 ? m.body.slice(0, 200) + '...' : m.body,
          truncated: m.body.length > 200,
          timestamp: m.timestamp,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(summarized) }],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(messages) }],
      };
    },
  });

  // group__<name>_<hash>__get_project_info
  mcpAdapter.registerMcpCommand({
    id: 'group-project.get_project_info',
    category: 'group-project',
    label: 'Get Project Info',
    mcp: { targetKind: 'group-project', nameSuffix: 'get_project_info' },
      description:
        'Get full project information including name, description, instructions, and members.\n\n' +
        'Call this when you first join a group project. The instructions field contains ' +
        'directives you MUST follow. The description explains the purpose of the group.\n\n' +
        'Returns a JSON object with { id, name, description, instructions, members[] }.',
      inputSchema: {
        type: 'object',
        properties: {
          include_members: {
            type: 'boolean',
            description: 'Include the list of connected members (default true).',
          },
        },
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const project = await groupProjectRegistry.get(targetId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Group project ${targetId} not found.` }],
          isError: true,
        };
      }

      const includeMembersList = args.include_members !== false;
      const result: Record<string, unknown> = {
        id: project.id,
        name: project.name,
        description: project.description,
        instructions: project.instructions,
        systemInstructions:
          'EFFICIENT POLLING: Always pass "since" (the latestTimestamp from your last read) ' +
          'to read_bulletin and read_topic. Only fetch topics where newMessageCount > 0. ' +
          'Use summary=true on read_topic for large topics, then read_message for specific messages.\n\n' +
          'TOPIC HYGIENE: Use specific, distinct topic names (e.g. "progress", "blockers", "decisions"). ' +
          'Avoid dumping all communication into one topic.\n\n' +
          'MESSAGE FORMAT: Post in plain text or short markdown. Avoid large JSON payloads in message bodies.',
      };

      if (includeMembersList) {
        const allBindings = bindingManager.getAllBindings();
        result.members = allBindings
          .filter(b => b.targetKind === 'group-project' && b.targetId === targetId)
          .map(b => ({
            agentId: b.agentId,
            agentName: b.agentName || b.agentId,
            status: resolveAgentStatus(b.agentId),
          }));
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  });

  // group__<name>_<hash>__shoulder_tap
  mcpAdapter.registerMcpCommand({
    id: 'group-project.shoulder_tap',
    category: 'group-project',
    label: 'Shoulder Tap',
    mcp: { targetKind: 'group-project', nameSuffix: 'shoulder_tap' },
      description:
        'Send an urgent direct message to a specific agent in this group project.\n\n' +
        'WARNING: This tool is NOT for normal communication. Use the bulletin board ' +
        '(post_bulletin / read_bulletin) for routine coordination. Shoulder tap should ' +
        'ONLY be used when you need immediate attention from a specific agent and the ' +
        'bulletin board is insufficient (e.g. the agent is unresponsive to bulletin posts, ' +
        'or there is a time-critical blocker).\n\n' +
        'The message is injected directly into the target agent\'s terminal input. ' +
        'The target agent\'s name must match one returned by list_members.\n\n' +
        'A record of the tap is also posted to the "shoulder-tap" bulletin board topic.',
      inputSchema: {
        type: 'object',
        properties: {
          target_agent_id: {
            type: 'string',
            description: 'The agentId of the target agent (from list_members).',
          },
          message: {
            type: 'string',
            description: 'The urgent message to deliver.',
          },
        },
        required: ['target_agent_id', 'message'],
      },
    handler: async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const targetAgentId = requireString(args, 'target_agent_id');
      const message = requireString(args, 'message');
      if (!targetAgentId || !message) {
        return { content: [{ type: 'text', text: 'Both target_agent_id and message are required.' }], isError: true };
      }

      const senderLabel = await resolveSenderLabel(agentId, targetId);

      try {
        const result = await executeShoulderTap({
          projectId: targetId,
          senderLabel,
          targetAgentId,
          message,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              taskId: result.taskId,
              delivered: result.delivered.length,
              failed: result.failed.length,
              details: [...result.delivered, ...result.failed],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Shoulder tap failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });

  // group__<name>_<hash>__broadcast
  mcpAdapter.registerMcpCommand({
    id: 'group-project.broadcast',
    category: 'group-project',
    label: 'Broadcast',
    mcp: { targetKind: 'group-project', nameSuffix: 'broadcast' },
      description:
        'Broadcast an urgent message to ALL agents in this group project.\n\n' +
        'WARNING: This tool is NOT for normal communication. Use the bulletin board ' +
        '(post_bulletin / read_bulletin) for routine coordination. Broadcast should ' +
        'ONLY be used for critical announcements that require immediate attention from ' +
        'every agent (e.g. "stop all work, critical issue found", "project goals changed").\n\n' +
        'The message is injected directly into each agent\'s terminal input. ' +
        'You (the sender) are excluded from the broadcast.\n\n' +
        'A record of the broadcast is also posted to the "shoulder-tap" bulletin board topic.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The urgent message to broadcast to all agents.',
          },
        },
        required: ['message'],
      },
    handler: async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const message = requireString(args, 'message');
      if (!message) {
        return { content: [{ type: 'text', text: 'message is required.' }], isError: true };
      }

      const senderLabel = await resolveSenderLabel(agentId, targetId);

      try {
        const result = await executeShoulderTap({
          projectId: targetId,
          senderLabel,
          targetAgentId: null, // broadcast to all
          message,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              taskId: result.taskId,
              delivered: result.delivered.length,
              failed: result.failed.length,
              details: [...result.delivered, ...result.failed],
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Broadcast failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });

  // group__<name>_<hash>__wake_agent
  mcpAdapter.registerMcpCommand({
    id: 'group-project.wake_agent',
    category: 'group-project',
    label: 'Wake Agent',
    mcp: { targetKind: 'group-project', nameSuffix: 'wake_agent' },
      description:
        'Wake a sleeping agent connected to this group project.\n\n' +
        'Use list_members to find agents with status "sleeping", then call this tool ' +
        'with their agentId to start them. Optionally provide a mission message that ' +
        'will be sent to the agent once it starts.\n\n' +
        'Returns the agent status after the wake attempt.',
      inputSchema: {
        type: 'object',
        properties: {
          target_agent_id: {
            type: 'string',
            description: 'The agentId of the sleeping agent to wake (from list_members).',
          },
          message: {
            type: 'string',
            description: 'Optional mission or message to send to the agent after waking.',
          },
        },
        required: ['target_agent_id'],
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const targetAgentId = requireString(args, 'target_agent_id');
      const message = optionalString(args, 'message');

      if (!targetAgentId) {
        return { content: [{ type: 'text', text: 'target_agent_id is required.' }], isError: true };
      }

      // Verify target is a member of this group project
      const allBindings = bindingManager.getAllBindings();
      const memberBinding = allBindings.find(
        b => b.targetKind === 'group-project' && b.targetId === targetId && b.agentId === targetAgentId,
      );
      if (!memberBinding) {
        return {
          content: [{ type: 'text', text: `Agent ${targetAgentId} is not a member of this group project.` }],
          isError: true,
        };
      }

      // Check if already running
      if (isAgentAlive(targetAgentId)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ agentId: targetAgentId, status: 'already_running' }),
          }],
        };
      }

      // Find the agent's durable config across all projects
      try {
        const projects = await projectStore.list();
        let agentConfig: Awaited<ReturnType<typeof listDurable>>[number] | undefined;
        let projectPath: string | undefined;

        for (const proj of projects) {
          const durables = await listDurable(proj.path);
          const found = durables.find(d => d.id === targetAgentId);
          if (found) {
            agentConfig = found;
            projectPath = proj.path;
            break;
          }
        }

        if (!agentConfig || !projectPath) {
          return {
            content: [{ type: 'text', text: `Could not find durable config for agent ${targetAgentId}.` }],
            isError: true,
          };
        }

        const cwd = agentConfig.worktreePath || projectPath;

        await spawnAgent({
          agentId: targetAgentId,
          projectPath,
          cwd,
          kind: 'durable',
          model: agentConfig.model,
          mission: message,
          orchestrator: agentConfig.orchestrator,
        });

        appLog('core:group-project', 'info', 'Agent woken via GP tool', {
          meta: { agentId: targetAgentId, projectPath },
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              agentId: targetAgentId,
              agentName: memberBinding.agentName || targetAgentId,
              status: 'starting',
              message: message || null,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to wake agent: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  });

  // group__<name>_<hash>__start_polling
  mcpAdapter.registerMcpCommand({
    id: 'group-project.start_polling',
    category: 'group-project',
    label: 'Start Polling',
    mcp: { targetKind: 'group-project', nameSuffix: 'start_polling' },
      description:
        'Send a polling start instruction to a specific connected agent.\n\n' +
        'Injects a message into the agent\'s terminal instructing it to begin polling ' +
        'the group project bulletin board. The instruction is tailored to the agent\'s ' +
        'orchestrator (e.g. Claude Code agents get /loop instructions).\n\n' +
        'The agent must be connected (not sleeping) for this to work.',
      inputSchema: {
        type: 'object',
        properties: {
          target_agent_id: {
            type: 'string',
            description: 'The agentId of the connected agent (from list_members).',
          },
        },
        required: ['target_agent_id'],
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const targetAgentId = requireString(args, 'target_agent_id');
      if (!targetAgentId) {
        return { content: [{ type: 'text', text: 'target_agent_id is required.' }], isError: true };
      }

      // Verify target is a member
      const allBindings = bindingManager.getAllBindings();
      const memberBinding = allBindings.find(
        b => b.targetKind === 'group-project' && b.targetId === targetId && b.agentId === targetAgentId,
      );
      if (!memberBinding) {
        return {
          content: [{ type: 'text', text: `Agent ${targetAgentId} is not a member of this group project.` }],
          isError: true,
        };
      }

      if (!isAgentAlive(targetAgentId)) {
        return {
          content: [{ type: 'text', text: `Agent ${targetAgentId} is sleeping — wake it first.` }],
          isError: true,
        };
      }

      const project = await groupProjectRegistry.get(targetId);
      const projectName = project?.name || targetId;
      const orchestrator = getAgentOrchestrator(targetAgentId);
      const msg = pollingStartMsg(projectName, orchestrator);

      injectPtyMessage(targetAgentId, msg);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            agentId: targetAgentId,
            agentName: memberBinding.agentName || targetAgentId,
            action: 'start_polling',
            delivered: true,
          }),
        }],
      };
    },
  });

  // group__<name>_<hash>__stop_polling
  mcpAdapter.registerMcpCommand({
    id: 'group-project.stop_polling',
    category: 'group-project',
    label: 'Stop Polling',
    mcp: { targetKind: 'group-project', nameSuffix: 'stop_polling' },
      description:
        'Send a polling stop instruction to a specific connected agent.\n\n' +
        'Injects a message into the agent\'s terminal instructing it to stop polling ' +
        'the group project bulletin board.\n\n' +
        'The agent must be connected (not sleeping) for this to work.',
      inputSchema: {
        type: 'object',
        properties: {
          target_agent_id: {
            type: 'string',
            description: 'The agentId of the connected agent (from list_members).',
          },
        },
        required: ['target_agent_id'],
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const targetAgentId = requireString(args, 'target_agent_id');
      if (!targetAgentId) {
        return { content: [{ type: 'text', text: 'target_agent_id is required.' }], isError: true };
      }

      // Verify target is a member
      const allBindings = bindingManager.getAllBindings();
      const memberBinding = allBindings.find(
        b => b.targetKind === 'group-project' && b.targetId === targetId && b.agentId === targetAgentId,
      );
      if (!memberBinding) {
        return {
          content: [{ type: 'text', text: `Agent ${targetAgentId} is not a member of this group project.` }],
          isError: true,
        };
      }

      if (!isAgentAlive(targetAgentId)) {
        return {
          content: [{ type: 'text', text: `Agent ${targetAgentId} is sleeping — cannot send stop instruction.` }],
          isError: true,
        };
      }

      const project = await groupProjectRegistry.get(targetId);
      const projectName = project?.name || targetId;
      const orchestrator = getAgentOrchestrator(targetAgentId);
      const msg = pollingStopMsg(projectName, orchestrator);

      injectPtyMessage(targetAgentId, msg);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            agentId: targetAgentId,
            agentName: memberBinding.agentName || targetAgentId,
            action: 'stop_polling',
            delivered: true,
          }),
        }],
      };
    },
  });

  // ── Read single message (always available) ──────────────────────────

  // group__<name>_<hash>__read_message
  mcpAdapter.registerMcpCommand({
    id: 'group-project.read_message',
    category: 'group-project',
    label: 'Read Message',
    mcp: { targetKind: 'group-project', nameSuffix: 'read_message' },
    description:
      'Read the full content of a single message by ID.\n\n' +
      'Use this after read_topic with summary=true to drill into specific messages ' +
      'that need full content. This avoids fetching entire topic histories.\n\n' +
      'Returns a single {id, sender, topic, body, timestamp} object, or null if not found.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The message ID to fetch (from read_topic results).',
        },
      },
      required: ['message_id'],
    },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const messageId = requireString(args, 'message_id');
      if (!messageId) {
        return { content: [{ type: 'text', text: 'message_id is required.' }], isError: true };
      }

      const board = getBulletinBoard(targetId);
      const message = await board.getMessageById(messageId);
      if (!message) {
        return { content: [{ type: 'text', text: `Message ${messageId} not found.` }], isError: true };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(message) }],
      };
    },
  });

  // ── Agent deletion tools (gated by agentDeletionEnabled) ────────────

  // group__<name>_<hash>__clear_topic
  mcpAdapter.registerMcpCommand({
    id: 'group-project.clear_topic',
    category: 'group-project',
    label: 'Clear Topic',
    mcp: { targetKind: 'group-project', nameSuffix: 'clear_topic' },
    description:
      'Delete an entire topic and all its messages from the bulletin board.\n\n' +
      'Use this to clean up stale or completed topics that are no longer relevant. ' +
      'This is a destructive operation — all messages in the topic will be permanently removed.\n\n' +
      'Cannot delete the "system" topic.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic name to delete.',
        },
      },
      required: ['topic'],
    },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = requireString(args, 'topic');
      if (!topic) {
        return { content: [{ type: 'text', text: 'topic is required.' }], isError: true };
      }

      if (topic === 'system') {
        return { content: [{ type: 'text', text: 'Cannot delete the "system" topic.' }], isError: true };
      }

      const board = getBulletinBoard(targetId);
      const deleted = await board.deleteTopic(topic);
      return {
        content: [{ type: 'text', text: JSON.stringify({ deleted, topic }) }],
      };
    },
  });

  // group__<name>_<hash>__delete_messages
  mcpAdapter.registerMcpCommand({
    id: 'group-project.delete_messages',
    category: 'group-project',
    label: 'Delete Messages',
    mcp: { targetKind: 'group-project', nameSuffix: 'delete_messages' },
    description:
      'Delete specific messages by ID from the bulletin board.\n\n' +
      'Use this to clean up outdated or irrelevant messages. Pass an array of message IDs ' +
      'to delete. Returns the count of successfully deleted messages.\n\n' +
      'Get message IDs from read_topic results.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic containing the messages.',
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of message IDs to delete.',
        },
      },
      required: ['topic', 'message_ids'],
    },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = requireString(args, 'topic');
      const messageIds = args.message_ids as string[] | undefined;

      if (!topic || !messageIds || !Array.isArray(messageIds)) {
        return { content: [{ type: 'text', text: 'Both topic and message_ids (array) are required.' }], isError: true };
      }

      const board = getBulletinBoard(targetId);
      let deletedCount = 0;
      for (const id of messageIds) {
        const ok = await board.deleteMessage(topic, id);
        if (ok) deletedCount++;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ deleted: deletedCount, requested: messageIds.length }) }],
      };
    },
  });

}
