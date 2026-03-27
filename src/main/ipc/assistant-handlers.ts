/**
 * IPC handlers for the Clubhouse Assistant MCP binding.
 *
 * Creates/removes the special 'assistant' binding that gives the
 * assistant agent access to app configuration tools.
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { bindingManager } from '../services/clubhouse-mcp';
import { agentRegistry } from '../services/agent-registry';
import { appLog } from '../services/log-service';
import { withValidatedArgs, stringArg } from './validation';

const ASSISTANT_TARGET_ID = 'clubhouse_assistant';

export function registerAssistantHandlers(): void {
  ipcMain.handle(IPC.ASSISTANT.BIND, withValidatedArgs(
    [stringArg()],
    (_event, agentId) => {
      if (!agentRegistry.get(agentId as string)) {
        throw new Error(`Agent not registered: ${agentId}`);
      }

      bindingManager.bind(agentId as string, {
        targetId: ASSISTANT_TARGET_ID,
        targetKind: 'assistant',
        label: 'Clubhouse Assistant',
      });

      appLog('core:assistant', 'info', 'Assistant MCP binding created', {
        meta: { agentId },
      });
    },
  ));

  ipcMain.handle(IPC.ASSISTANT.UNBIND, withValidatedArgs(
    [stringArg()],
    (_event, agentId) => {
      bindingManager.unbind(agentId as string, ASSISTANT_TARGET_ID);
      appLog('core:assistant', 'info', 'Assistant MCP binding removed', {
        meta: { agentId },
      });
    },
  ));
}
