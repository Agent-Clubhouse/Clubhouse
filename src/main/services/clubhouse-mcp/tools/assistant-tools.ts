/**
 * MCP tools for the Clubhouse Assistant agent — barrel re-export.
 *
 * Read-only tools (Phase 3) let the assistant understand app state.
 * Write tools (Phase 4) let the assistant configure projects, agents, and settings.
 * Canvas tools (Phase 5) let the assistant build visual workflows.
 *
 * All tools are registered as 'assistant' target kind and scoped exclusively
 * to the assistant agent via a binding.
 *
 * Tools are split across focused modules:
 *   assistant-context-tools   — filesystem reads, app state, help search
 *   assistant-config-tools    — settings and theme read/write
 *   assistant-agent-tools     — agent CRUD
 *   assistant-project-tools   — project write (add/remove/update)
 *   assistant-canvas-tools    — canvas and card management
 *   assistant-plugin-tools    — plugin management and marketplace
 *   assistant-command-tools   — command palette access
 */

import { appLog } from '../../log-service';
import { registerContextTools } from './assistant-context-tools';
import { registerConfigTools } from './assistant-config-tools';
import { registerAgentTools } from './assistant-agent-tools';
import { registerProjectTools } from './assistant-project-tools';
import { registerCanvasTools } from './assistant-canvas-tools';
import { registerPluginTools } from './assistant-plugin-tools';
import { registerCommandTools } from './assistant-command-tools';

/**
 * Register all assistant MCP tools (read + write).
 * Call once at MCP system initialization.
 */
export function registerAssistantTools(): void {
  appLog('core:mcp', 'info', 'Registering assistant MCP tools');
  registerContextTools();
  registerConfigTools();
  registerAgentTools();
  registerProjectTools();
  registerCanvasTools();
  registerPluginTools();
  registerCommandTools();
}
