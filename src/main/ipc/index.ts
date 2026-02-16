import { registerPtyHandlers } from './pty-handlers';
import { registerProjectHandlers } from './project-handlers';
import { registerFileHandlers } from './file-handlers';
import { registerGitHandlers } from './git-handlers';
import { registerAgentHandlers } from './agent-handlers';
import { registerAgentSettingsHandlers } from './agent-settings-handlers';
import { registerAppHandlers } from './app-handlers';
import { registerPluginHandlers } from './plugin-handlers';
import * as hookServer from '../services/hook-server';
import { registerBuiltinProviders } from '../orchestrators';
import * as logService from '../services/log-service';

export function registerAllHandlers(): void {
  // Register orchestrator providers before anything else
  registerBuiltinProviders();

  // Initialize logging service early so handlers can use it
  logService.init();

  registerPtyHandlers();
  registerProjectHandlers();
  registerFileHandlers();
  registerGitHandlers();
  registerAgentHandlers();
  registerAgentSettingsHandlers();
  registerAppHandlers();
  registerPluginHandlers();

  // Start the hook server for agent status events
  hookServer.start().catch((err) => {
    console.error('Failed to start hook server:', err);
  });
}
