/**
 * IPC handlers for MCP binding management.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { isMcpEnabledForAny } from '../services/mcp-settings';
import { bindingManager, bridgeServer } from '../services/clubhouse-mcp';
import { registerAgentTools } from '../services/clubhouse-mcp/tools/agent-tools';
import { registerBrowserTools, registerWebview, unregisterWebview } from '../services/clubhouse-mcp/tools/browser-tools';
import { registerGroupProjectTools } from '../services/clubhouse-mcp/tools/group-project-tools';
import { registerAgentQueueTools } from '../services/clubhouse-mcp/tools/agent-queue-tools';
import { registerAssistantTools } from '../services/clubhouse-mcp/tools/assistant-tools';
import { registerCanvasCommandHandler } from '../services/clubhouse-mcp/canvas-command';
import { agentRegistry } from '../services/agent-registry';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, objectArg, arrayArg } from './validation';

/** Verify the agentId refers to a registered agent. Throws if not. */
function assertAgentRegistered(agentId: string): void {
  if (!agentRegistry.get(agentId)) {
    appLog('core:mcp', 'warn', 'Rejected MCP binding request — agent not registered', { meta: { agentId } });
    throw new Error(`Agent not registered: ${agentId}`);
  }
}

/**
 * Verify the IPC caller is an application window, not a webview or detached WebContents.
 * Prevents webview-hosted content (e.g. browser plugin pages) from calling binding APIs.
 */
function assertCallerIsAppWindow(event: Electron.IpcMainInvokeEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    appLog('core:mcp', 'warn', 'Rejected MCP binding request — caller is not an application window');
    throw new Error('MCP binding operation rejected — unauthorized caller');
  }
}

function broadcastBindingsChanged(): void {
  broadcastToAllWindows(IPC.MCP_BINDING.BINDINGS_CHANGED, bindingManager.getAllBindings());
}

let handlersRegistered = false;

export function registerMcpBindingHandlers(): void {
  if (handlersRegistered) return; // Already registered — idempotent
  if (!isMcpEnabledForAny()) {
    return; // Feature not enabled for any project — don't register handlers
  }

  handlersRegistered = true;

  // Register tool templates
  registerAgentTools();
  registerBrowserTools();
  registerGroupProjectTools();
  registerAgentQueueTools();
  registerAssistantTools();
  registerCanvasCommandHandler();

  appLog('core:mcp', 'info', 'MCP binding handlers registered');

  // Subscribe to binding changes for renderer broadcast
  bindingManager.onChange(() => {
    broadcastBindingsChanged();
  });

  ipcMain.handle(IPC.MCP_BINDING.GET_BINDINGS, () => {
    return bindingManager.getAllBindings();
  });

  ipcMain.handle(IPC.MCP_BINDING.BIND, withValidatedArgs(
    [stringArg(), objectArg<{ targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }>()],
    (event, agentId, target) => {
      assertCallerIsAppWindow(event);
      assertAgentRegistered(agentId as string);
      bindingManager.bind(agentId as string, target as { targetId: string; targetKind: 'browser' | 'agent' | 'terminal'; label: string; agentName?: string; targetName?: string; projectName?: string });
      appLog('core:mcp', 'info', 'Binding created', {
        meta: {
          agentId,
          agentName: target.agentName,
          targetId: target.targetId,
          targetName: target.targetName,
          targetKind: target.targetKind,
        },
      });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.UNBIND, withValidatedArgs(
    [stringArg(), stringArg()],
    (event, agentId, targetId) => {
      assertCallerIsAppWindow(event);
      assertAgentRegistered(agentId as string);
      bindingManager.unbind(agentId as string, targetId as string);
      appLog('core:mcp', 'info', 'Binding removed', { meta: { agentId, targetId } });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.SET_INSTRUCTIONS, withValidatedArgs(
    [stringArg(), stringArg(), objectArg<Record<string, string>>()],
    (event, agentId, targetId, instructions) => {
      assertCallerIsAppWindow(event);
      assertAgentRegistered(agentId as string);
      bindingManager.setInstructions(agentId as string, targetId as string, instructions as Record<string, string>);
      appLog('core:mcp', 'info', 'Binding instructions updated', { meta: { agentId, targetId } });
    },
  ));

  ipcMain.handle(IPC.MCP_BINDING.SET_DISABLED_TOOLS, withValidatedArgs(
    [stringArg(), stringArg(), arrayArg(stringArg())],
    (event, agentId, targetId, disabledTools) => {
      assertCallerIsAppWindow(event);
      assertAgentRegistered(agentId as string);
      bindingManager.setDisabledTools(agentId as string, targetId as string, disabledTools as string[]);
      appLog('core:mcp', 'info', 'Binding disabled tools updated', { meta: { agentId, targetId, disabledTools } });
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

let bridgeStarted = false;

/** Conditionally start the MCP bridge server if MCP is enabled for any project. */
export function maybeStartMcpBridge(): void {
  if (bridgeStarted) return; // Already started — idempotent
  if (!isMcpEnabledForAny()) {
    return;
  }

  bridgeStarted = true;

  bridgeServer.start().catch((err) => {
    bridgeStarted = false; // Allow retry on failure
    appLog('core:mcp', 'error', 'Failed to start MCP bridge server', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/**
 * Called when MCP or Clubhouse Mode settings change. If MCP becomes enabled
 * for any project, lazily start the bridge and register handlers without
 * requiring an app restart.
 */
export function onMcpSettingsChanged(): void {
  if (!isMcpEnabledForAny()) return;
  registerMcpBindingHandlers();
  maybeStartMcpBridge();
}

/** For testing only: reset the registration guard so handlers can be re-registered. */
export function _resetHandlersForTesting(): void {
  handlersRegistered = false;
}
