/**
 * Group Project MCP Tools — allows agents linked to a group project
 * to coordinate via a shared bulletin board.
 */

import { registerToolTemplate } from '../tool-registry';
import { bindingManager } from '../binding-manager';
import { getBulletinBoard } from '../../group-project-bulletin';
import { groupProjectRegistry } from '../../group-project-registry';
import { executeShoulderTap } from '../../group-project-shoulder-tap';
import type { McpToolResult } from '../types';

/** Register all group-project tool templates. */
export function registerGroupProjectTools(): void {
  // group__<name>_<hash>__list_members
  registerToolTemplate(
    'group-project',
    'list_members',
    {
      description:
        'List all agents currently connected to this group project.\n\n' +
        'Returns a JSON array of { agentId, agentName } objects. Use this to discover ' +
        'who is collaborating with you in this group project.\n\n' +
        'For full project context including instructions, use get_project_info.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async (targetId: string, _agentId: string, _args: Record<string, unknown>): Promise<McpToolResult> => {
      // Find all bindings where targetKind is group-project and targetId matches
      const allBindings = bindingManager.getAllBindings();
      const members = allBindings
        .filter(b => b.targetKind === 'group-project' && b.targetId === targetId)
        .map(b => ({ agentId: b.agentId, agentName: b.agentName || b.agentId }));

      return {
        content: [{ type: 'text', text: JSON.stringify(members, null, 2) }],
      };
    },
  );

  // group__<name>_<hash>__post_bulletin
  registerToolTemplate(
    'group-project',
    'post_bulletin',
    {
      description:
        'Post a message to the group project bulletin board.\n\n' +
        'The bulletin board is the PRIMARY communication channel for group coordination. ' +
        'Post regular progress updates, questions, decisions, and status changes.\n\n' +
        'Your identity is automatically included as the sender. The "system" topic is ' +
        'reserved for lifecycle events — use any other topic name freely.\n\n' +
        'Suggested topics: "progress", "questions", "decisions", "blockers"',
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
    },
    async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = args.topic as string;
      const body = args.body as string;

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

      // Resolve sender identity
      const agentBindings = bindingManager.getBindingsForAgent(agentId);
      const binding = agentBindings.find(b => b.targetId === targetId && b.targetKind === 'group-project');
      const sender = binding?.agentName
        ? `${binding.agentName}${binding.projectName ? '@' + binding.projectName : ''}`
        : agentId;

      try {
        const board = getBulletinBoard(targetId);
        const msg = await board.postMessage(sender, topic, body);
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
  );

  // group__<name>_<hash>__read_bulletin
  registerToolTemplate(
    'group-project',
    'read_bulletin',
    {
      description:
        'Read the bulletin board digest — shows all topics with message counts.\n\n' +
        'This is the key coordination primitive. Poll every 10-30 seconds to stay aware of ' +
        'what other agents are doing. When you see topics with new messages, use read_topic ' +
        'to get the full content.\n\n' +
        'Returns a JSON array of { topic, messageCount, newMessageCount, latestTimestamp }.\n\n' +
        'Always check the "system" topic for join/leave lifecycle events.\n\n' +
        'Check the "shoulder-tap" topic for direct messages to you.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. If provided, newMessageCount reflects only messages after this time.',
          },
        },
      },
    },
    async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const since = args.since as string | undefined;
      const board = getBulletinBoard(targetId);
      const digest = await board.getDigest(since);
      return {
        content: [{ type: 'text', text: JSON.stringify(digest, null, 2) }],
      };
    },
  );

  // group__<name>_<hash>__read_topic
  registerToolTemplate(
    'group-project',
    'read_topic',
    {
      description:
        'Read full messages from a specific bulletin board topic.\n\n' +
        'Always expand the "system" topic for lifecycle awareness (agent joins/leaves). ' +
        'Use the since parameter to get only new messages since your last read.\n\n' +
        'Returns a JSON array of { id, sender, topic, body, timestamp }.',
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
        },
        required: ['topic'],
      },
    },
    async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const topic = args.topic as string;
      if (!topic) {
        return {
          content: [{ type: 'text', text: 'topic is required.' }],
          isError: true,
        };
      }
      const since = args.since as string | undefined;
      const limit = args.limit as number | undefined;
      const board = getBulletinBoard(targetId);
      const messages = await board.getTopicMessages(topic, since, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  // group__<name>_<hash>__get_project_info
  registerToolTemplate(
    'group-project',
    'get_project_info',
    {
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
    },
    async (targetId: string, _agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
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
        systemInstructions: 'Post messages in plain text or markdown format when possible for best readability.',
      };

      if (includeMembersList) {
        const allBindings = bindingManager.getAllBindings();
        result.members = allBindings
          .filter(b => b.targetKind === 'group-project' && b.targetId === targetId)
          .map(b => ({ agentId: b.agentId, agentName: b.agentName || b.agentId }));
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // group__<name>_<hash>__shoulder_tap
  registerToolTemplate(
    'group-project',
    'shoulder_tap',
    {
      description:
        'Send an urgent direct message to another agent in this group project.\n\n' +
        'The message is injected directly into the target agent\'s input — use this for ' +
        'time-sensitive requests that cannot wait for bulletin board polling.\n\n' +
        'The target agent will receive response instructions to reply via the bulletin board ' +
        'on the "shoulder-tap" topic. Omit target_agent_id or set to "all" to broadcast.\n\n' +
        'Returns delivery results: { taskId, messageId, delivered[], failed[] }.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The urgent message to deliver.',
          },
          target_agent_id: {
            type: 'string',
            description: 'Agent ID to tap. Omit or "all" to broadcast to all members.',
          },
          task_id: {
            type: 'string',
            description: 'Optional task ID for tracking responses.',
          },
        },
        required: ['message'],
      },
    },
    async (targetId: string, agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const message = args.message as string;
      if (!message) {
        return {
          content: [{ type: 'text', text: 'message is required.' }],
          isError: true,
        };
      }

      // Resolve sender identity
      const agentBindings = bindingManager.getBindingsForAgent(agentId);
      const binding = agentBindings.find(b => b.targetId === targetId && b.targetKind === 'group-project');
      const senderLabel = binding?.agentName
        ? `${binding.agentName}${binding.projectName ? '@' + binding.projectName : ''}`
        : agentId;

      const targetAgentId = (args.target_agent_id as string) || null;

      try {
        const result = await executeShoulderTap({
          projectId: targetId,
          senderLabel,
          targetAgentId: targetAgentId === 'all' ? null : targetAgentId,
          message,
          taskId: args.task_id as string | undefined,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Shoulder tap failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
