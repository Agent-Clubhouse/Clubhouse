/**
 * Group Project MCP Tools — allows agents linked to a group project
 * to coordinate via a shared bulletin board.
 */

import { groupPostWakePreflight } from '../../group-project-wake';
import { resolveMentions } from '../../../../shared/group-project-mentions';
import { bindingManager } from '../binding-manager';
import { mcpAdapter } from '../mcp-adapter';
import { groupProjectRegistry } from '../../group-project-registry';
import { groupProjectHost } from '../../group-project-host';
import { groupProjectToolMembers, groupProjectMentionMembers } from '../../group-project-tool-members';
import { isAgentAlive } from '../../group-project-lifecycle';
import { getAgentRuntime } from '../../agent-runtime';
import * as agentSystem from '../../agent-system';
import { listTopicSubscriptions, NEW_CHANNEL_NAME_MESSAGE, noteSenderAddress, setTopicSubscription, usableTopic } from '../../group-project-delivery';
import * as annexEventBus from '../../annex-event-bus';
import { appLog } from '../../log-service';
import type { McpToolResult } from '../types';
import { requireString, optionalString, optionalNumber, optionalBoolean } from './validation';
import { findDurableAgentConfig, sleepAgent } from './agent-lifecycle';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { IPC } from '../../../../shared/ipc-channels';

function findProjectMember(targetId: string, targetAgentId: string) {
  const allBindings = bindingManager.getAllBindings();
  return allBindings.find(
    b => b.targetKind === 'group-project' && b.targetId === targetId && b.agentId === targetAgentId,
  );
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

  const members = await groupProjectMentionMembers(targetId);
  const gp = await groupProjectHost.get(targetId);
  const address = gp ? groupProjectHost.addressOf(gp, agentId) : agentId;
  const own = members.find(m => m.address === address);
  const name = binding?.agentName || own?.name;
  if (name && members.filter(m => m.name.toLowerCase() === name.toLowerCase()).length > 1) {
    return `${name} (${own?.computer || 'This computer'})`;
  }
  return binding?.agentName
    ? `${binding.agentName}${projectName ? '@' + projectName : ''}`
    : agentId;
}

/**
 * The `get_project_info` guidance. How a member hears about posts follows the group project's
 * post notices (#3362).
 */
function projectSystemInstructions(): string {
  const channelModel =
    'CHANNEL MODEL: A group project is a shared message board for a team of agents. Every project has protected "general" and "control" channels, plus a per-agent "inbox-<agent-name>" channel. Agents granted lead coordinate the team.\n' +
    '- Check your inbox, "control" and "general" when you join and between tasks. Follow other channels when you are asked to.\n' +
    '- control: changes to how the team works. general: team-wide announcements only; avoid posting there otherwise.\n' +
    '- inbox-<your-name>: your direct inbox. Reach another agent through theirs. Prefer inboxes over short-lived channels.\n' +
    '- work channels: create one only after agreeing in "control", and only for scoped coordination, for example dev, QA and design working together on one piece.\n\n';
  const delivery = 'NOTICES: You get a notice when someone posts to a channel you subscribe to (your inbox, "control" and "general" by default) or names you as @name. ' +
      'Do not poll the board in a loop. When a notice arrives, read the channel it names with read_topic, or call read_bulletin once for an overview. Use summary=true for large reads and read_message for full bodies.\n\n';
  return channelModel + delivery +
    'POSTING: Post replies on the channel where the work is happening. Do not cross-post. Keep messages short: plain text or short markdown, not large JSON.';
}

/** Register all group-project tool templates. */
export function registerGroupProjectTools(): void {
  // group__<name>_<hash>__list_members
  mcpAdapter.registerMcpCommand({
    id: 'group-project.list_members',
    category: 'group-project',
    label: 'List Members',
    mcp: { targetKind: 'group-project', nameSuffix: 'list_members', grant: { actions: ['group_project.read'], target: 'bound' } },
    description:
        'List group project members as compact JSON: name, address (identity), computer, inbox, status, lastSeen when known, and roles (lead/admin). ' +
        'Status is awake (live), busy (a chat turn is running), asleep (no live process), or unknown (no runtime observation). ' +
        'Remote states report what the host last saw, with lastSeen; they may be older than this call. ' +
        'Use the exact inbox channel, including any suffix. Mentions accept @name or @name@computer; an ambiguous plain name matches all members with that name. ' +
        'For full project context including instructions, use get_project_info.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    handler: async (targetId: string, _agentId: string, _args: Record<string, unknown>): Promise<McpToolResult> => {
      const members = await groupProjectToolMembers(targetId);

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
    mcp: { targetKind: 'group-project', nameSuffix: 'post_bulletin', grant: { actions: ['group_project.post'], target: 'bound' } },
    description:
        'Post a message to a channel on the group project board. Urgent posts skip notice batching and notice rate limits; busy recipients receive them after their current turn, never interrupted. Direct inbox posts and mentions can resume sleeping durable members when waking is allowed; held notices survive restart.\n\n' +
        'Waking needs the group wake grant and a durable member with a resumable session. At most three wake attempts per recipient per ten minutes; other notices stay unread. A remote-origin wake also needs the receiving computer’s Allow grant for group_project.lead. Offline computers catch up from the board; wakePreflight is not a final delivery receipt.\n\n' +
        'CHANNEL MODEL:\n' +
        '- "general" (protected): team-wide announcements only. Avoid posting here otherwise.\n' +
        '- "control" (protected): changes to how the team works, and agreeing on new channels before anyone creates one.\n' +
        '- "inbox-<agent-name>" (protected): an agent\'s direct inbox. Post here for 1:1 work with that agent. Prefer inboxes over short-lived channels.\n' +
        '- work channels: only for scoped coordination agreed in "control", for example dev, QA and design working together on one piece.\n\n' +
        'Post replies where the work is happening, and do not cross-post.\n\n' +
        'Your identity is set automatically. The "system" channel is reserved. ' +
        'Keep messages concise — plain text or short markdown beats large JSON payloads.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Channel name. "system" is reserved. Use short-kebab-case for new work channels.',
          },
          urgent: { type: 'boolean', description: 'Send the notice next in line, bypassing batching and notice rate limits.' },
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
      const urgent = optionalBoolean(args, 'urgent');

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
      // A new channel's name appears in other members' notices (#3362): only plain names. Existing channels and inboxes are fine.
      if (!(await usableTopic(targetId, topic))) {
        return { content: [{ type: 'text', text: NEW_CHANNEL_NAME_MESSAGE }], isError: true };
      }

      const sender = await resolveSenderLabel(agentId, targetId);

      try {
        const msg = await groupProjectHost.post(targetId, sender, topic, body, { author: { agentId, label: sender }, urgent });
        // Members' notices leave the sender out by address, not by name.
        if (!msg.pending) noteSenderAddress(msg.id, agentId);
        if (msg.pending) {
          // A copy of a group project hosted on another computer that is away (#3363): queued for it.
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                posted: false, queued: true, waitingFor: msg.pending.waitingFor, topic: msg.topic,
                note: `Waiting for ${msg.pending.waitingFor}. It is posted when that computer is back; if it is refused, you are told why.`,
              }),
            }],
          };
        }
        const { ambiguous, addresses } = resolveMentions(body, await groupProjectMentionMembers(targetId));
        const wakePreflight = await groupPostWakePreflight(targetId, agentId, msg.topic, addresses).catch((err: unknown) => {
          // telemetry-exempt: post is already saved; return an honest preflight limitation
          appLog('core:group-project', 'warn', 'Post saved but wake preflight unavailable', { meta: { groupProjectId: targetId, error: String(err) } });
          return [{ address: agentId, reason: 'Post saved; wake preflight unavailable. Recipients recheck permission on delivery.' }];
        });
        const warnings = ambiguous.map((name) => `@${name} matches more than one member; it notified all of them. Use @${name}@<computer> to reach one.`);
        annexEventBus.emitBulletinMessage(targetId, msg);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ posted: true, messageId: msg.id, topic: msg.topic, timestamp: msg.timestamp, ...(warnings.length && { warnings }), ...(wakePreflight.length && { wakePreflight }) }),
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
    mcp: { targetKind: 'group-project', nameSuffix: 'read_bulletin', grant: { actions: ['group_project.read'], target: 'bound' } },
      description:
        'Get a digest of channels on the group project board: {topic, messageCount, newMessageCount, latestTimestamp, isProtected} per channel.\n\n' +
        'Pass "since" (the latestTimestamp from your last read) on every call after your first to keep the digest cheap.\n' +
        'Pass "channels" to restrict the digest to the channels you care about. You get a notice when someone posts to your channels, so read when one arrives rather than in a loop. Your standard set is:\n' +
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
      const digest = await groupProjectHost.readDigest(targetId, since, channels);
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
    mcp: { targetKind: 'group-project', nameSuffix: 'read_topic', grant: { actions: ['group_project.read'], target: 'bound' } },
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
      const messages = await groupProjectHost.readTopic(targetId, topic, since, limit);

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
    mcp: { targetKind: 'group-project', nameSuffix: 'get_project_info', grant: { actions: ['group_project.read'], target: 'bound' } },
      description:
        'Get full project information including name, description, instructions, and members.\n\n' +
        'Call this when you first join a group project. The instructions field contains ' +
        'directives you MUST follow. The description explains the purpose of the group.\n\n' +
        'Returns a JSON object with { id, name, scope, description, instructions, members[] }. ' +
        'Scope is null for a legacy group project awaiting migration.',
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
        scope: project.scope ?? null,
        description: project.description,
        instructions: project.instructions,
        systemInstructions: projectSystemInstructions(),
      };

      if (includeMembersList) {
        result.members = await groupProjectToolMembers(targetId);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  });



  // group__<name>_<hash>__wake_agent
  mcpAdapter.registerMcpCommand({
    id: 'group-project.wake_agent',
    category: 'group-project',
    label: 'Wake Agent',
    mcp: { targetKind: 'group-project', nameSuffix: 'wake_agent', grant: [{ actions: ['group_project.lead'], target: 'bound' }, { actions: ['agent.wake'], target: 'group_members' }, { actions: ['agent.message'], target: 'group_members', ifArgs: ['message'] }] },
      description:
        'Wake a sleeping agent connected to this group project.\n\n' +
        'Use list_members to find agents with status "sleeping", then call this tool ' +
        'with their agentId to start them. Optionally provide a mission message that ' +
        'will be sent to the agent once it starts. It starts a fresh session unless ' +
        'resume is true; see resume for when to use it.\n\n' +
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
            description: 'Resume the agent\'s previous CLI session instead of starting fresh. Defaults to false. '
              + 'Resuming reloads its whole earlier conversation, which costs tokens and brings stale context. '
              + 'Resume only to follow up on an open task this agent already worked on: fixes after a review, a re-review after a fix, finishing an interrupted task. '
              + 'For new work (a new issue or task, a first review, a first judge pass) leave this out and put everything the agent needs in message.',
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
    mcp: { targetKind: 'group-project', nameSuffix: 'sleep_agent', grant: [{ actions: ['group_project.lead'], target: 'bound' }, { actions: ['agent.sleep'], target: 'group_members' }] },
      description:
        'Put a connected agent in this group project to sleep.\n\n' +
        'Gracefully stops the target agent using the same lifecycle path as the Clubhouse UI stop action, ' +
        'and returns once it has exited. Without force, it refuses a chat agent that is mid-turn and any ' +
        'agent in the CLI view, whose turn state is unknown. Running helpers of the target are listed in the result. ' +
        'Use list_members first; the target_agent_id must be a member of this project.',
      inputSchema: {
        type: 'object',
        properties: {
          target_agent_id: {
            type: 'string',
            description: 'The agentId of the connected agent to stop (from list_members).',
          },
          force: {
            type: 'boolean',
            description: 'Stop it even if it is mid-turn or its turn state is unknown. The turn in progress is lost. Defaults to false.',
          },
        },
        required: ['target_agent_id'],
      },
    handler: async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
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

      return sleepAgent({
        callerId: agentId,
        targetId: targetAgentId,
        targetName: memberBinding.agentName || targetAgentId,
        force: args.force === true,
      });
    },
  });



  // group__<name>_<hash>__subscribe_topic
  mcpAdapter.registerMcpCommand({
    id: 'group-project.subscribe_topic',
    category: 'group-project',
    label: 'Subscribe Topic',
    mcp: { targetKind: 'group-project', nameSuffix: 'subscribe_topic', grant: { actions: ['group_project.read'], target: 'bound' } },
    description:
        'Choose which channels send you a notice when someone posts (#3362).\n\n' +
        'By default you hear about posts in "general", "control" and your inbox, and any post that names you as @your-name. ' +
        'Subscribe to a work channel you are part of, or unsubscribe from one you no longer follow. ' +
        'A burst of posts arrives as one notice. Returns your subscribed channels. Omit `topic` to list them.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Channel name.' },
        subscribe: { type: 'boolean', description: 'true to hear about it (default), false to stop.' },
      },
    },
    handler: async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = optionalString(args, 'topic');
      const subscribe = optionalBoolean(args, 'subscribe') ?? true;
      const binding = findProjectMember(targetId, agentId);
      const name = binding?.agentName || agentId;
      try {
        const topics = topic
          ? await setTopicSubscription(targetId, agentId, name, topic, subscribe)
          : await listTopicSubscriptions(targetId, agentId, name);
        return { content: [{ type: 'text', text: JSON.stringify({ subscribed: topics }) }] };
      } catch (err) {
        // telemetry-exempt: a bad channel name or too many changes, returned to the agent
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  });


  // ── Read single message (always available) ──────────────────────────

  // group__<name>_<hash>__read_message
  mcpAdapter.registerMcpCommand({
    id: 'group-project.read_message',
    category: 'group-project',
    label: 'Read Message',
    mcp: { targetKind: 'group-project', nameSuffix: 'read_message', grant: { actions: ['group_project.read'], target: 'bound' } },
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

      const message = await groupProjectHost.getMessage(targetId, messageId);
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
    mcp: { targetKind: 'group-project', nameSuffix: 'clear_topic', grant: { actions: ['group_project.lead'], target: 'bound' } },
    description:
      'Delete an entire channel and all its messages from the group project board.\n\n' +
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
    handler: async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = requireString(args, 'topic');
      if (!topic) {
        return { content: [{ type: 'text', text: 'topic is required.' }], isError: true };
      }

      if (topic === 'system') {
        return { content: [{ type: 'text', text: 'Cannot delete the "system" topic.' }], isError: true };
      }

      const deleted = await groupProjectHost.deleteTopic(targetId, topic, { author: { agentId, label: agentId } });
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
    mcp: { targetKind: 'group-project', nameSuffix: 'clear_agent', grant: [{ actions: ['group_project.lead'], target: 'bound' }, { actions: ['agent.reset'], target: 'group_members' }] },
    description:
      'Send a /clear command to a connected agent, clearing its conversation context.\n\n' +
      'Injects /clear directly into the target agent\'s CLI. Use this when the agent\'s ' +
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

      const clearRuntime = getAgentRuntime(targetAgentId);
      if (!clearRuntime) {
        return { content: [{ type: 'text', text: `Agent ${targetAgentId} does not accept input in its current runtime.` }], isError: true };
      }
      await clearRuntime.clearContext();

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
    mcp: { targetKind: 'group-project', nameSuffix: 'compact_agent', grant: [{ actions: ['group_project.lead'], target: 'bound' }, { actions: ['agent.reset'], target: 'group_members' }] },
    description:
      'Send a /compact command to a connected agent, compacting its conversation context.\n\n' +
      'Injects /compact directly into the target agent\'s CLI. Use this when the agent\'s ' +
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

      const compactRuntime = getAgentRuntime(targetAgentId);
      if (!compactRuntime) {
        return { content: [{ type: 'text', text: `Agent ${targetAgentId} does not accept input in its current runtime.` }], isError: true };
      }
      await compactRuntime.compact();

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
    mcp: { targetKind: 'group-project', nameSuffix: 'delete_messages', grant: { actions: ['group_project.lead'], target: 'bound' } },
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
    handler: async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = requireString(args, 'topic');
      const messageIds = args.message_ids as string[] | undefined;

      if (!topic || !messageIds || !Array.isArray(messageIds)) {
        return { content: [{ type: 'text', text: 'Both topic and message_ids (array) are required.' }], isError: true };
      }

      let deletedCount = 0;
      for (const id of messageIds) {
        const ok = await groupProjectHost.deleteMessage(targetId, topic, id, { author: { agentId, label: agentId } });
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
    mcp: { targetKind: 'group-project', nameSuffix: 'set_project_info', grant: { actions: ['group_project.admin'], target: 'bound' } },
    description:
      'Update the group project description and/or instructions.\n\n' +
      'The description explains the purpose of the group; the instructions are directives ' +
      'every member must follow (returned by get_project_info). Provide either or both — ' +
      'omitted fields are left unchanged. Returns the updated { description, instructions }.\n\n' +
      'This is a privileged tool. It is only available to agents granted admin on this group project. Lead is a separate grant and does not include it.',
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
      // Admin of this group project is an explicit grant, checked before the handler runs (#3360).
      const description = optionalString(args, 'description');
      const instructions = optionalString(args, 'instructions');
      if (description === undefined && instructions === undefined) {
        return { content: [{ type: 'text', text: 'Provide at least one of description or instructions.' }], isError: true };
      }

      const updated = await groupProjectHost.update(targetId, {
        ...(description !== undefined ? { description } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
      }, { author: { agentId, label: agentId } });

      return {
        content: [{ type: 'text', text: JSON.stringify({ description: updated?.description, instructions: updated?.instructions }) }],
      };
    },
  });

}
