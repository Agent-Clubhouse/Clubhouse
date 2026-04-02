/**
 * Core canvas MCP tools — available to ALL agents via global tool registration.
 *
 * These expose canvas management as a first-class Clubhouse MCP surface:
 * create, list, navigate, add cards, and connect cards.
 *
 * Operations are dispatched to the renderer via sendCanvasCommand() which
 * bridges to the canvas-command-handler running in the renderer process.
 */

import { registerGlobalTool } from '../tool-registry';
import { sendCanvasCommand } from '../canvas-command';
import { appLog } from '../../log-service';
import type { McpToolResult } from '../types';

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Register all core canvas MCP tools.
 * Call once during MCP system initialization.
 */
export function registerCanvasTools(): void {
  appLog('core:mcp', 'info', 'Registering core canvas MCP tools');

  // ── create_canvas ─────────────────────────────────────────────────────
  registerGlobalTool(
    'canvas__create_canvas',
    {
      description:
        'Create a new canvas workspace. Returns the canvas ID and name. ' +
        'Optionally provide a project_id to create under a specific project, ' +
        'or omit for an app-level canvas. Use open_canvas afterwards to navigate to it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Display name for the canvas. A random name is generated if omitted.',
          },
          project_id: {
            type: 'string',
            description: 'Project ID to create the canvas under. Omit for app-level canvas.',
          },
        },
      },
    },
    async (_agentId, args) => {
      const result = await sendCanvasCommand('add_canvas', {
        name: args.name,
        project_id: args.project_id,
      });
      if (!result.success) {
        return errorResult(result.error || 'Failed to create canvas');
      }
      return textResult(JSON.stringify(result.data));
    },
  );

  // ── list_canvases ─────────────────────────────────────────────────────
  registerGlobalTool(
    'canvas__list_canvases',
    {
      description:
        'List all canvases. Returns an array of { id, name, cardCount } for each canvas. ' +
        'Provide project_id to list canvases for a specific project, or omit for app-level canvases.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID to list canvases for. Omit for app-level canvases.',
          },
        },
      },
    },
    async (_agentId, args) => {
      const result = await sendCanvasCommand('list_canvases', {
        project_id: args.project_id,
      });
      if (!result.success) {
        return errorResult(result.error || 'Failed to list canvases');
      }
      return textResult(JSON.stringify(result.data));
    },
  );

  // ── open_canvas ───────────────────────────────────────────────────────
  registerGlobalTool(
    'canvas__open_canvas',
    {
      description:
        'Navigate to a specific canvas by ID. Sets the active project, switches the ' +
        'explorer tab to the canvas view, and activates the canvas. The UI will ' +
        'immediately show the target canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          canvas_id: {
            type: 'string',
            description: 'The ID of the canvas to navigate to.',
          },
          project_id: {
            type: 'string',
            description: 'Project ID hint to speed up canvas lookup. Optional.',
          },
        },
        required: ['canvas_id'],
      },
    },
    async (_agentId, args) => {
      const result = await sendCanvasCommand('navigate_to_canvas', {
        canvas_id: args.canvas_id,
        project_id: args.project_id,
      });
      if (!result.success) {
        return errorResult(result.error || 'Failed to navigate to canvas');
      }
      return textResult(JSON.stringify(result.data));
    },
  );

  // ── add_card_to_canvas ────────────────────────────────────────────────
  registerGlobalTool(
    'canvas__add_card_to_canvas',
    {
      description:
        'Add a card (view) to a canvas. Supports types: agent, anchor, sticky-note, zone. ' +
        'For agent cards, provide agent_id to bind the card to a real agent. ' +
        'Returns the new view ID.',
      inputSchema: {
        type: 'object',
        properties: {
          canvas_id: {
            type: 'string',
            description: 'The canvas to add the card to.',
          },
          type: {
            type: 'string',
            description: 'Card type: "agent", "anchor", "sticky-note", or "zone".',
          },
          display_name: {
            type: 'string',
            description: 'Display name for the card.',
          },
          position: {
            type: 'object',
            description: 'Position { x, y } on the canvas. Defaults to { x: 100, y: 100 }.',
          },
          size: {
            type: 'object',
            description: 'Size { width, height } of the card.',
          },
          agent_id: {
            type: 'string',
            description: 'Agent ID to bind to the card (required for agent type cards).',
          },
          project_id: {
            type: 'string',
            description: 'Project ID for project-scoped canvases.',
          },
          content: {
            type: 'string',
            description: 'Text content for sticky-note cards.',
          },
          color: {
            type: 'string',
            description: 'Color for sticky-note cards: yellow, pink, blue, green, or purple.',
          },
        },
        required: ['canvas_id', 'type'],
      },
    },
    async (_agentId, args) => {
      const result = await sendCanvasCommand('add_view', {
        canvas_id: args.canvas_id,
        type: args.type,
        display_name: args.display_name,
        position: args.position,
        size: args.size,
        agent_id: args.agent_id,
        project_id: args.project_id,
        content: args.content,
        color: args.color,
      });
      if (!result.success) {
        return errorResult(result.error || 'Failed to add card to canvas');
      }
      return textResult(JSON.stringify(result.data));
    },
  );

  // ── connect_cards ─────────────────────────────────────────────────────
  registerGlobalTool(
    'canvas__connect_cards',
    {
      description:
        'Create a connection (wire) between two cards on a canvas. The source must be an ' +
        'agent card. Creates an MCP binding so the source agent can communicate with the ' +
        'target. Agent-to-agent connections are bidirectional by default.',
      inputSchema: {
        type: 'object',
        properties: {
          canvas_id: {
            type: 'string',
            description: 'The canvas containing both cards.',
          },
          source_view_id: {
            type: 'string',
            description: 'View ID of the source card (must be an agent card).',
          },
          target_view_id: {
            type: 'string',
            description: 'View ID of the target card.',
          },
          bidirectional: {
            type: 'boolean',
            description: 'Whether the connection is bidirectional. Defaults to true for agent-to-agent, false otherwise.',
          },
          project_id: {
            type: 'string',
            description: 'Project ID for project-scoped canvases.',
          },
        },
        required: ['canvas_id', 'source_view_id', 'target_view_id'],
      },
    },
    async (_agentId, args) => {
      const result = await sendCanvasCommand('connect_views', {
        canvas_id: args.canvas_id,
        source_view_id: args.source_view_id,
        target_view_id: args.target_view_id,
        bidirectional: args.bidirectional,
        project_id: args.project_id,
      });
      if (!result.success) {
        return errorResult(result.error || 'Failed to connect cards');
      }
      return textResult(JSON.stringify(result.data));
    },
  );
}
