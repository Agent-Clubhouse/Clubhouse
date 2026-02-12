import { registerPtyHandlers } from './pty-handlers';
import { registerProjectHandlers } from './project-handlers';
import { registerFileHandlers } from './file-handlers';
import { registerGitHandlers } from './git-handlers';
import { registerAgentHandlers } from './agent-handlers';
import { registerAgentSettingsHandlers } from './agent-settings-handlers';
import { registerAppHandlers } from './app-handlers';
import * as hookServer from '../services/hook-server';

export function registerAllHandlers(): void {
  registerPtyHandlers();
  registerProjectHandlers();
  registerFileHandlers();
  registerGitHandlers();
  registerAgentHandlers();
  registerAgentSettingsHandlers();
  registerAppHandlers();

  // Start the hook server for agent status events
  hookServer.start().catch((err) => {
    console.error('Failed to start hook server:', err);
  });
}
