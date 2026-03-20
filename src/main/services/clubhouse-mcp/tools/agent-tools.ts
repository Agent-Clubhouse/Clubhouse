/**
 * Agent-to-Agent MCP Tools — allows linked agents to communicate.
 */

import { registerToolTemplate } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import * as ptyManager from '../../pty-manager';
import * as structuredManager from '../../structured-manager';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';

/** Register all agent-to-agent tool templates. */
export function registerAgentTools(): void {
  // agent__<targetId>__send_message
  registerToolTemplate(
    'agent',
    'send_message',
    {
      description: 'Send a message to the linked agent. The message will appear as input to the agent.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The message to send to the agent.',
          },
        },
        required: ['message'],
      },
    },
    async (targetId, agentId, args): Promise<McpToolResult> => {
      const message = args.message as string;
      if (!message) {
        return { content: [{ type: 'text', text: 'Missing required argument: message' }], isError: true };
      }

      const reg = agentRegistry.get(targetId);
      if (!reg) {
        appLog('core:mcp', 'warn', 'send_message: target agent not found in registry', {
          meta: { sourceAgent: agentId, targetAgent: targetId },
        });
        return { content: [{ type: 'text', text: `Agent ${targetId} is not running` }], isError: true };
      }
      appLog('core:mcp', 'info', 'send_message: target resolved', {
        meta: { sourceAgent: agentId, targetAgent: targetId, runtime: reg.runtime },
      });

      try {
        if (reg.runtime === 'pty') {
          ptyManager.write(targetId, message + '\n');
          return { content: [{ type: 'text', text: 'Message sent successfully' }] };
        } else if (reg.runtime === 'structured') {
          await structuredManager.sendMessage(targetId, message);
          return { content: [{ type: 'text', text: 'Message sent successfully' }] };
        } else {
          return { content: [{ type: 'text', text: `Agent runtime "${reg.runtime}" does not support input` }], isError: true };
        }
      } catch (err) {
        appLog('core:mcp', 'error', 'Failed to send message to agent', {
          meta: { sourceAgent: agentId, targetAgent: targetId, error: err instanceof Error ? err.message : String(err) },
        });
        return { content: [{ type: 'text', text: `Failed to send message: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  // agent__<targetId>__get_status
  registerToolTemplate(
    'agent',
    'get_status',
    {
      description: 'Get the current status of the linked agent.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async (targetId, agentId, _args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      const running = !!reg;

      const status: Record<string, unknown> = {
        running,
        runtime: reg?.runtime || null,
      };

      appLog('core:mcp', 'info', 'get_status: resolved', {
        meta: { sourceAgent: agentId, targetAgent: targetId, running, runtime: reg?.runtime },
      });

      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  );

  // agent__<targetId>__read_output
  registerToolTemplate(
    'agent',
    'read_output',
    {
      description: 'Read recent output from the linked agent.',
      inputSchema: {
        type: 'object',
        properties: {
          lines: {
            type: 'number',
            description: 'Number of lines to read (default 50, max 500).',
          },
        },
      },
    },
    async (targetId, agentId, args): Promise<McpToolResult> => {
      const reg = agentRegistry.get(targetId);
      if (!reg) {
        appLog('core:mcp', 'warn', 'read_output: target agent not found in registry', {
          meta: { sourceAgent: agentId, targetAgent: targetId },
        });
        return { content: [{ type: 'text', text: `Agent ${targetId} is not running` }], isError: true };
      }

      let lines = (args.lines as number) || 50;
      lines = Math.min(lines, 500);

      try {
        if (reg.runtime === 'pty') {
          const buffer = ptyManager.getBuffer(targetId);
          if (!buffer) {
            return { content: [{ type: 'text', text: 'No output available' }] };
          }
          // Take last N lines
          const allLines = buffer.split('\n');
          const lastLines = allLines.slice(-lines).join('\n');
          return { content: [{ type: 'text', text: lastLines }] };
        } else {
          return { content: [{ type: 'text', text: `Output reading not supported for runtime "${reg.runtime}"` }], isError: true };
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to read output: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}
