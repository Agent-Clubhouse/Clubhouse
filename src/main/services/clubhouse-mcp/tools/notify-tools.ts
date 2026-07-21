/**
 * Notify tools — a deliberate "get the user's attention" MCP tool.
 *
 * Unlike orchestrator lifecycle hooks (idle/stop/notification), this tool is
 * only invoked when an agent explicitly decides it needs the human. The handler
 * routes to the renderer (IPC.APP.AGENT_ATTENTION), which runs it through the
 * shared notification gating (checkAndNotify) so it surfaces as a native
 * desktop notification with click-to-navigate + auto-dismiss — consistent with
 * every other Clubhouse notification.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { IPC } from '../../../../shared/ipc-channels';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { appLog } from '../../log-service';

/** Max length for the notification body before truncation. */
export const NOTIFY_MESSAGE_MAX_LENGTH = 240;
/** Max length for the notification title before truncation. */
export const NOTIFY_TITLE_MAX_LENGTH = 80;

/** Payload broadcast to renderer windows when an agent requests attention. */
export interface AgentAttentionPayload {
  message: string;
  title?: string;
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Register the global `notify_user` tool (available to ALL agents, no binding
 * required).
 */
export function registerNotifyTools(): void {
  registerGlobalTool(
    'notify_user',
    {
      description:
        'Send the human a desktop notification asking for their attention. Use this ' +
        'SPARINGLY — only when you are genuinely blocked and need the user to act ' +
        '(a decision, missing input, sign-off). Do NOT use it for routine progress, ' +
        'for going idle, or after finishing work (those are handled automatically). ' +
        'Clicking the notification jumps the user to your view.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The notification body — a short, actionable sentence about what you need.',
          },
          title: {
            type: 'string',
            description: 'Optional notification title. Defaults to "<agent name> needs you".',
          },
        },
        required: ['message'],
      },
    },
    async (agentId: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const rawMessage = typeof args.message === 'string' ? args.message.trim() : '';
      if (!rawMessage) {
        return textResult('Missing required argument: message', true);
      }

      const message = rawMessage.slice(0, NOTIFY_MESSAGE_MAX_LENGTH);
      const rawTitle = typeof args.title === 'string' ? args.title.trim() : '';
      const title = rawTitle ? rawTitle.slice(0, NOTIFY_TITLE_MAX_LENGTH) : undefined;

      const payload: AgentAttentionPayload = title ? { message, title } : { message };
      broadcastToAllWindows(IPC.APP.AGENT_ATTENTION, agentId, payload);

      appLog('core:mcp', 'info', 'notify_user: agent requested user attention', {
        meta: { agentId, hasTitle: Boolean(title) },
      });

      return textResult('Notification sent to the user.');
    },
  );
}
