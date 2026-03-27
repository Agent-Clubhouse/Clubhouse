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
import { registerAnnexHandlers, maybeStartAnnex, maybeStartAnnexClient } from './annex-handlers';
import { registerMcpBindingHandlers, maybeStartMcpBridge } from './mcp-binding-handlers';
import { registerGroupProjectHandlers } from './group-project-handlers';
import { registerAgentQueueHandlers } from './agent-queue-handlers';
import { registerAnnexClientHandlers } from './annex-client-handlers';
import { registerMarketplaceHandlers } from './marketplace-handlers';
import { registerProfileHandlers } from './profile-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerAssistantHandlers } from './assistant-handlers';
import * as hookServer from '../services/hook-server';
import { registerBuiltinProviders, getAllProviders } from '../orchestrators';
import { autoDetectDefaults } from '../services/orchestrator-settings';
import * as logService from '../services/log-service';
import { registerDefaultBroadcastPolicies } from '../util/ipc-broadcast-policies';

export function registerAllHandlers(): void {
  // Register orchestrator providers before anything else
  registerBuiltinProviders();

  // Auto-detect available CLIs on first run so users only see providers
  // they actually have installed.  Fire-and-forget: store.save() updates
  // the in-memory cache synchronously; the disk write is async.
  autoDetectDefaults(getAllProviders()).catch(() => {});

  // Initialize logging service early so handlers can use it
  logService.init();

  // Register broadcast throttle policies before handlers that emit events
  registerDefaultBroadcastPolicies();

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
  registerAnnexClientHandlers();
  registerMarketplaceHandlers();
  registerProfileHandlers();
  registerSettingsHandlers();
  registerMcpBindingHandlers();
  registerGroupProjectHandlers();
  registerAgentQueueHandlers();
  registerAssistantHandlers();

  // Start the hook server for agent status events
  hookServer.start().catch((err) => {
    logService.appLog('core:hook-server', 'error', 'Failed to start hook server', {
      meta: { error: err?.message ?? String(err), stack: err?.stack },
    });
  });

  // Conditionally start Annex LAN server if enabled in settings
  maybeStartAnnex();

  // Conditionally start Annex client (Bonjour discovery) for satellite detection
  maybeStartAnnexClient();

  // Conditionally start MCP bridge server for agent-widget interaction
  maybeStartMcpBridge();
}
