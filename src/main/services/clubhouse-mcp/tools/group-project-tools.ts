/**
 * Group Project MCP Tools — allows agents linked to a group project
 * to coordinate via a shared bulletin board.
 */

import { bindingManager } from '../binding-manager';
import { mcpAdapter } from '../mcp-adapter';
import { getBulletinBoard } from '../../group-project-bulletin';
import { groupProjectRegistry } from '../../group-project-registry';
import { isProjectAdmin } from '../../../../shared/group-project-admin';
import { isAgentAlive, injectPtyMessage } from '../../group-project-lifecycle';
import * as ptyManager from '../../pty-manager';
import { executeShoulderTap } from '../../group-project-shoulder-tap';
import * as agentSystem from '../../agent-system';
import { listDurable } from '../../agent-config';
import * as projectStore from '../../project-store';
import { agentRegistry, getAgentOrchestrator } from '../../agent-registry';
import { pollingStartMsg, pollingStopMsg } from '../../../../shared/polling-messages';
import * as annexEventBus from '../../annex-event-bus';
import { appLog } from '../../log-service';
import type { McpToolResult } from '../types';
import { requireString, optionalString, optionalNumber } from './validation';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { IPC } from '../../../../shared/ipc-channels';

/** Resolve agent status for a member entry. */
function resolveAgentStatus(agentId: string): 'connected' | 'sleeping' {
  return isAgentAlive(agentId) ? 'connected' : 'sleeping';
}

function findProjectMember(targetId: string, targetAgentId: string) {
  const allBindings = bindingManager.getAllBindings();
  return allBindings.find(
    b => b.targetKind === 'group-project' && b.targetId === targetId && b.agentId === targetAgentId,
  );
}

async function findDurableAgentConfig(targetAgentId: string): Promise<{
  agentConfig: Awaited<ReturnType<typeof listDurable>>[number];
  projectPath: string;
} | null> {
  const projects = await projectStore.list();
  for (const proj of projects) {
    const durables = await listDurable(proj.path);
    const found = durables.find(d => d.id === targetAgentId);
    if (found) {
      return { agentConfig: found, projectPath: proj.path };
    }
  }
  return null;
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
        'Post a message to a channel on the project board.\n\n' +
        'CHANNEL MODEL:\n' +
        '- "general" (protected): introductions and broad announcements. Keep traffic low.\n' +
        '- "control" (protected): coordination — tell other agents where to look ("follow #fix-login-bug") and agree on channel naming.\n' +
        '- "inbox-<agent-name>" (protected): an agent\'s direct inbox. Post here for 1:1 async work with that agent.\n' +
        '- work channels: create them liberally for scoped work (e.g. "fix-login-bug", "schema-v2"). One focused topic per channel.\n\n' +
        'Introduce yourself on "general" when you first join. Prefer scoped work channels over posting shared context to "general". ' +
        'Post replies where the work is happening — do not cross-post.\n\n' +
        'Your identity is set automatically. The "system" channel is reserved. ' +
        'Keep messages concise — plain text or short markdown beats large JSON payloads.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Channel name. "system" is reserved. Use short-kebab-case for new work channels.',
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
        'Get a digest of channels on the project board — {topic, messageCount, newMessageCount, latestTimestamp, isProtected} per channel.\n\n' +
        'Pass "since" (the latestTimestamp from your last read) on every call after your first to keep the digest cheap.\n' +
        'Pass "channels" to restrict the digest to the channels you care about. Your standard poll set is:\n' +
        '  ["general", "control", "inbox-<your-name>", ...any work channels you are actively tracking]\n' +
        'Only drill into a channel with read_topic when its newMessageCount > 0.\n\n' +
        'Ignoring unrelated chatter is the whole point — do not read every channel on the board.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. If provided, newMessageCount reflects only messages after this time.',
          },
          channels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional allow-list of channel names to include in the digest. Omit for all channels.',
          },
        },
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const since = optionalString(args, 'since');
      const channels = Array.isArray(args.channels)
        ? (args.channels as unknown[]).filter((c): c is string => typeof c === 'string')
        : undefined;
      const board = getBulletinBoard(targetId);
      const digest = await board.getDigest(since, channels);
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
        'Read messages from a specific channel.\n\n' +
        'Always pass "since" (latestTimestamp from your last read of this channel) to fetch only new messages — avoids re-reading the full history.\n' +
        'Use summary=true on large channels to get truncated bodies (~200 chars); then call read_message by id for any full body you actually need.\n\n' +
        'Returns a compact JSON array of {id, sender, topic, body, timestamp}.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Channel name to read.',
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
          'CHANNEL MODEL: Every project has protected "general" and "control" channels, plus a per-agent "inbox-<agent-name>" channel. Work channels are freeform — create them with post_bulletin as needed.\n' +
          '- general: introduce yourself when you join ("I am <name>, working on <focus>"); post announcements that affect everyone. Keep traffic low.\n' +
          '- control: set up shared work ("new channel #fix-login-bug, follow if relevant"), agree on naming, resolve cross-stream questions.\n' +
          '- inbox-<your-name>: your direct inbox. Check it every poll. Other agents post here for 1:1 asks.\n' +
          '- work channels: make them liberally for focused coordination. One topic per channel. Prefer this over cross-posting to "general".\n\n' +
          'POLLING: Call read_bulletin with since=<latestTimestamp from last read> and channels=["general","control","inbox-<your-name>", ...subscribed work channels]. ' +
          'Only drill into a channel with read_topic when its newMessageCount > 0. Use summary=true for large reads and read_message for full bodies.\n\n' +
          'POSTING: Introduce yourself on "general" after you first join. Post replies on the channel where the work is happening. Do not cross-post. Keep messages short — plain text or short markdown, not large JSON.',
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
        'Send an urgent, ephemeral message directly into a specific agent\'s terminal.\n\n' +
        'NOT for routine coordination — post to a channel instead. Use shoulder_tap only when a channel post is insufficient: ' +
        'the target is unresponsive, or there is a time-critical blocker.\n\n' +
        'The message is injected as terminal input. No bulletin record is created — if a reply is expected, ask the target to post it on your inbox channel ("inbox-<your-name>").\n\n' +
        'The target_agent_id must match an agentId returned by list_members.',
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
        'Broadcast an urgent, ephemeral message to every agent in this project (injected into each terminal; no bulletin record).\n\n' +
        'NOT for routine coordination — post to "general" for that. Use broadcast only for critical, all-hands announcements ' +
        '("stop all work, critical issue found", "project goals changed"). You (the sender) are excluded.',
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
          resume: {
            type: 'boolean',
            description: 'Whether to resume the agent\'s previous CLI session. Defaults to false.',
          },
        },
        required: ['target_agent_id'],
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const targetAgentId = requireString(args, 'target_agent_id');
      const message = optionalString(args, 'message');
      const resume = args.resume === true;

      if (!targetAgentId) {
        return { content: [{ type: 'text', text: 'target_agent_id is required.' }], isError: true };
      }

      // Verify target is a member of this group project
      const memberBinding = findProjectMember(targetId, targetAgentId);
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
        const durable = await findDurableAgentConfig(targetAgentId);
        if (!durable) {
          return {
            content: [{ type: 'text', text: `Could not find durable config for agent ${targetAgentId}.` }],
            isError: true,
          };
        }
        const { agentConfig, projectPath } = durable;

        const cwd = agentConfig.worktreePath || projectPath;

        // Notify renderer the wake is starting so the agent card can show a
        // transitional state. spawnAgent will broadcast AGENT_AWOKE on success,
        // which flips the card from "waking" to "running" and surfaces the PTY.
        broadcastToAllWindows(IPC.AGENT.AGENT_WAKING, targetAgentId);

        await agentSystem.spawnAgent({
          agentId: targetAgentId,
          projectPath,
          cwd,
          kind: 'durable',
          model: agentConfig.model,
          mission: message,
          orchestrator: agentConfig.orchestrator,
          freeAgentMode: agentConfig.freeAgentMode,
          structuredMode: agentConfig.structuredMode,
          resume,
          sessionId: resume ? agentConfig.lastSessionId : undefined,
        });

        appLog('core:group-project', 'info', 'Agent woken via GP tool', {
          meta: { agentId: targetAgentId, projectPath, resume },
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              agentId: targetAgentId,
              agentName: memberBinding.agentName || targetAgentId,
              status: 'starting',
              resume,
              message: message || null,
            }),
          }],
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        broadcastToAllWindows(IPC.AGENT.AGENT_WAKE_FAILED, targetAgentId, errorMessage);
        return {
          content: [{ type: 'text', text: `Failed to wake agent: ${errorMessage}` }],
          isError: true,
        };
      }
    },
  });

  // group__<name>_<hash>__sleep_agent
  mcpAdapter.registerMcpCommand({
    id: 'group-project.sleep_agent',
    category: 'group-project',
    label: 'Sleep Agent',
    mcp: { targetKind: 'group-project', nameSuffix: 'sleep_agent' },
      description:
        'Put a connected agent in this group project to sleep.\n\n' +
        'Gracefully stops the target agent using the same lifecycle path as the Clubhouse UI stop action. ' +
        'Use list_members first; the target_agent_id must be a member of this project.',
      inputSchema: {
        type: 'object',
        properties: {
          target_agent_id: {
            type: 'string',
            description: 'The agentId of the connected agent to stop (from list_members).',
          },
        },
        required: ['target_agent_id'],
      },
    handler: async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const targetAgentId = requireString(args, 'target_agent_id');
      if (!targetAgentId) {
        return { content: [{ type: 'text', text: 'target_agent_id is required.' }], isError: true };
      }

      const memberBinding = findProjectMember(targetId, targetAgentId);
      if (!memberBinding) {
        return {
          content: [{ type: 'text', text: `Agent ${targetAgentId} is not a member of this group project.` }],
          isError: true,
        };
      }

      if (!isAgentAlive(targetAgentId)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              agentId: targetAgentId,
              agentName: memberBinding.agentName || targetAgentId,
              status: 'already_sleeping',
            }),
          }],
        };
      }

      try {
        const tracked = agentRegistry.get(targetAgentId);
        const durable = tracked ? null : await findDurableAgentConfig(targetAgentId);
        const projectPath = tracked?.projectPath || durable?.projectPath;
        if (!projectPath) {
          return {
            content: [{ type: 'text', text: `Could not determine project path for agent ${targetAgentId}.` }],
            isError: true,
          };
        }

        await agentSystem.killAgent(targetAgentId, projectPath, tracked?.orchestrator || durable?.agentConfig.orchestrator);
        broadcastToAllWindows(IPC.AGENT.AGENT_SLEEPING, targetAgentId);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              agentId: targetAgentId,
              agentName: memberBinding.agentName || targetAgentId,
              action: 'sleep_agent',
              delivered: true,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to sleep agent: ${err instanceof Error ? err.message : String(err)}` }],
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
      'Delete an entire channel and all its messages from the project board.\n\n' +
      'Use this to clean up stale or completed work channels that are no longer relevant. ' +
      'Destructive — all messages in the channel are permanently removed.\n\n' +
      'The "system" channel cannot be deleted, and protected channels ("general", "control", and any "inbox-<name>") will still be recreated automatically when used.',
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

  // group__<name>_<hash>__clear_agent
  mcpAdapter.registerMcpCommand({
    id: 'group-project.clear_agent',
    category: 'group-project',
    label: 'Clear Agent Context',
    mcp: { targetKind: 'group-project', nameSuffix: 'clear_agent' },
    description:
      'Send a /clear command to a connected agent, clearing its conversation context.\n\n' +
      'Injects /clear directly into the target agent\'s terminal. Use this when the agent\'s ' +
      'context is bloated or stale and a fresh slate would improve its performance.\n\n' +
      'The agent must be connected (not sleeping). The target_agent_id must match an agentId ' +
      'returned by list_members.',
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

      ptyManager.write(targetAgentId, '/clear');
      ptyManager.write(targetAgentId, '\r');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            agentId: targetAgentId,
            agentName: memberBinding.agentName || targetAgentId,
            action: 'clear',
            delivered: true,
          }),
        }],
      };
    },
  });

  // group__<name>_<hash>__compact_agent
  mcpAdapter.registerMcpCommand({
    id: 'group-project.compact_agent',
    category: 'group-project',
    label: 'Compact Agent Context',
    mcp: { targetKind: 'group-project', nameSuffix: 'compact_agent' },
    description:
      'Send a /compact command to a connected agent, compacting its conversation context.\n\n' +
      'Injects /compact directly into the target agent\'s terminal. Use this when the agent\'s ' +
      'context is large and you want it summarized without losing continuity.\n\n' +
      'The agent must be connected (not sleeping). The target_agent_id must match an agentId ' +
      'returned by list_members.',
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

      ptyManager.write(targetAgentId, '/compact');
      ptyManager.write(targetAgentId, '\r');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            agentId: targetAgentId,
            agentName: memberBinding.agentName || targetAgentId,
            action: 'compact',
            delivered: true,
          }),
        }],
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

  // group__<name>_<hash>__set_project_info
  mcpAdapter.registerMcpCommand({
    id: 'group-project.set_project_info',
    category: 'group-project',
    label: 'Set Project Info',
    mcp: { targetKind: 'group-project', nameSuffix: 'set_project_info' },
    description:
      'Update the group project description and/or instructions (project-lead tool).\n\n' +
      'The description explains the purpose of the group; the instructions are directives ' +
      'every member must follow (returned by get_project_info). Provide either or both — ' +
      'omitted fields are left unchanged. Returns the updated { description, instructions }.\n\n' +
      'This is a privileged, admin-only tool; it is only available to project leads.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'New project description (purpose of the group).' },
        instructions: { type: 'string', description: 'New project instructions (rules members must follow).' },
      },
    },
    handler: async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const project = await groupProjectRegistry.get(targetId);
      if (!project) {
        return { content: [{ type: 'text', text: `Group project ${targetId} not found.` }], isError: true };
      }
      // Defense in depth: the tool is already role-gated out of non-admins' tool
      // lists, but reject here too in case it is ever invoked directly.
      if (!isProjectAdmin(project.metadata, agentId)) {
        return { content: [{ type: 'text', text: 'Only a project admin can update the project description or instructions.' }], isError: true };
      }

      const description = optionalString(args, 'description');
      const instructions = optionalString(args, 'instructions');
      if (description === undefined && instructions === undefined) {
        return { content: [{ type: 'text', text: 'Provide at least one of description or instructions.' }], isError: true };
      }

      const updated = await groupProjectRegistry.update(targetId, {
        ...(description !== undefined ? { description } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({ description: updated?.description, instructions: updated?.instructions }) }],
      };
    },
  });

}
