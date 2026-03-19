/**
 * IPC handlers for MCP binding management.
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as experimentalSettings from '../services/experimental-settings';
import { bindingManager, bridgeServer } from '../services/clubhouse-mcp';
import { registerAgentTools } from '../services/clubhouse-mcp/tools/agent-tools';
import { registerBrowserTools, registerWebview, unregisterWebview } from '../services/clubhouse-mcp/tools/browser-tools';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, objectArg } from './validation';

function broadcastBindingsChanged(): void {
  broadcastToAllWindows(IPC.MCP_BINDING.BINDINGS_CHANGED, bindingManager.getAllBindings());
}

export function registerMcpBindingHandlers(): void {
  const expSettings = experimentalSettings.getSettings();
  if (!expSettings.clubhouseMcp) {
    return; // Feature not enabled — don't register any handlers
  }

  // Register tool templates
  registerAgentTools();
  registerBrowserTools();

  appLog('core:mcp', 'info', 'MCP binding handlers registered');

  // Subscribe to binding changes for renderer broadcast
  bindingManager.onChange(() => {
    broadcastBindingsChanged();
  });

  ipcMain.handle(IPC.MCP_BINDING.GET_BINDINGS, () => {
    return bindingManager.getAllBindings();
  });

  ipcMain.handle(IPC.MCP_BINDING.BIND, withValidatedArgs(
    [stringArg(), objectArg<{ targetId: string; targetKind: string; label: string }>()],
    (_event, agentId, target) => {
      bindingManager.bind(agentId as string, target as { targetId: string; targetKind: 'browser' | 'agent' | 'terminal'; label: string });
      appLog('core:mcp', 'info', 'Binding created', {
        meta: { agentId, targetId: target.targetId, targetKind: target.targetKind },
      });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.UNBIND, withValidatedArgs(
    [stringArg(), stringArg()],
    (_event, agentId, targetId) => {
      bindingManager.unbind(agentId as string, targetId as string);
      appLog('core:mcp', 'info', 'Binding removed', { meta: { agentId, targetId } });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.REGISTER_WEBVIEW, withValidatedArgs(
    [stringArg(), stringArg()],
    (_event, widgetId, webContentsId) => {
      registerWebview(widgetId as string, parseInt(webContentsId as string, 10));
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.UNREGISTER_WEBVIEW, withValidatedArgs(
    [stringArg()],
    (_event, widgetId) => {
      unregisterWebview(widgetId as string);
    },
  ));
}

/** Conditionally start the MCP bridge server if experimental flag is on. */
export function maybeStartMcpBridge(): void {
  const expSettings = experimentalSettings.getSettings();
  if (!expSettings.clubhouseMcp) {
    return;
  }

  bridgeServer.start().catch((err) => {
    appLog('core:mcp', 'error', 'Failed to start MCP bridge server', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}
