/**
 * Registers every Clubhouse MCP tool, as the app does at startup. One list,
 * so tool-grants.test registers exactly what the app registers and can check
 * that each tool declares its grant (#2967).
 */
import { registerHandoffCapacityTools } from './handoff-capacity-tools';
import { registerHandoffTools } from './handoff-tools';
import { registerFederatedRequestTools } from './federated-request-tools';
import { registerRemoteDispatcherTools } from './remote-dispatcher-tools';
import { registerAgentTools } from './agent-tools';
import { registerBrowserTools } from './browser-tools';
import { registerGroupProjectTools } from './group-project-tools';
import { registerGroupProjectDirectoryTools } from './group-project-directory-tools';
import { registerNotifyTools } from './notify-tools';
import { registerHelperDisposeTools } from './helper-dispose-tools';
import { registerHelperTools } from './helper-tools';
import { registerModelTools } from './model-tools';
import { registerDispatcherTools } from './dispatcher-tools';
import { registerDispatcherChatTools } from './dispatcher-chat-tools';
import { registerDispatcherSearchTools } from './dispatcher-search-tools';
import { registerAppearanceTools } from './appearance-tools';
import { registerSettingsReadTools } from './settings-read-tools';
import { registerDispatcherControlTools } from './dispatcher-control-tools';
import { registerDispatcherPresenceTools } from './dispatcher-presence-tools';
import { registerManagedTools } from './managed-tools';
import { registerHelperQuestionTools } from './helper-question-tools';
import { registerConnectionTools } from './connection-tools';
import { registerActionTools } from './action-tools';
import { registerHelperPresetTools } from './helper-preset-tools';
import { registerGrantRequestTools } from './grant-request-tools';
import { registerAgentCardTools } from './agent-card-tools';
import { registerDeviceTools } from './device-tools';
import { registerProjectAddTools } from './project-add-tools';
import { registerProjectImportTools } from './project-import-tools';
import { registerAppUpdateTools } from './app-update-tools';
import { registerAnnexDeliveryTools } from './annex-delivery-tools';
import { registerAnnexNetworkTools } from './annex-network-tools';

export function registerClubhouseMcpTools(): void {
  registerHandoffCapacityTools();
  registerHandoffTools();
  registerAgentTools();
  registerFederatedRequestTools();
  registerRemoteDispatcherTools();
  registerBrowserTools();
  registerGroupProjectTools();
  registerGroupProjectDirectoryTools();
  registerNotifyTools();
  registerHelperDisposeTools();
  registerHelperTools();
  registerModelTools();
  registerDispatcherTools();
  registerDispatcherChatTools();
  registerDispatcherSearchTools();
  registerAppearanceTools();
  registerSettingsReadTools();
  registerDispatcherControlTools();
  registerDispatcherPresenceTools();
  registerManagedTools();
  registerHelperQuestionTools();
  registerConnectionTools();
  registerActionTools();
  registerHelperPresetTools();
  registerGrantRequestTools();
  registerAgentCardTools();
  registerDeviceTools();
  registerProjectAddTools();
  registerProjectImportTools();
  registerAppUpdateTools();
  registerAnnexDeliveryTools();
  registerAnnexNetworkTools();
}
