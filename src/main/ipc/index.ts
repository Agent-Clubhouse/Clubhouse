import { registerPtyHandlers } from './pty-handlers';
import { registerProjectHandlers } from './project-handlers';
import { registerFileHandlers } from './file-handlers';
import { registerGitHandlers } from './git-handlers';
import { registerAgentHandlers } from './agent-handlers';
import { registerAgentSettingsHandlers } from './agent-settings-handlers';
import { registerAppHandlers } from './app-handlers';
import { registerPluginHandlers } from './plugin-handlers';
import { registerProcessHandlers } from './process-handlers';
import { registerWindowHandlers } from './window-handlers';
import { registerAnnexHandlers, maybeStartAnnex } from './annex-handlers';
import { registerMarketplaceHandlers } from './marketplace-handlers';
import * as hookServer from '../services/hook-server';
import { registerBuiltinProviders } from '../orchestrators';
import * as logService from '../services/log-service';

export function registerAllHandlers(): void {
  // Register orchestrator providers before anything else
  registerBuiltinProviders();

  // Initialize logging service early so handlers can use it
  logService.init();

  logService.appLog('core:startup', 'info', 'Registering IPC handlers');

  registerPtyHandlers();
  registerProjectHandlers();
  registerFileHandlers();
  registerGitHandlers();
  registerAgentHandlers();
  registerAgentSettingsHandlers();
  registerAppHandlers();
  registerPluginHandlers();
  registerProcessHandlers();
  registerWindowHandlers();
  registerAnnexHandlers();
  registerMarketplaceHandlers();

  // Start the hook server for agent status events
  hookServer.start().catch((err) => {
    logService.appLog('core:hook-server', 'error', 'Failed to start hook server', {
      meta: { error: err?.message ?? String(err), stack: err?.stack },
    });
  });

  // Conditionally start Annex LAN server if enabled in settings
  maybeStartAnnex();
}
