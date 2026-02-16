import type { PluginManifest, PluginModule } from '../../../shared/plugin-types';
import { manifest as hubManifest } from './hub/manifest';
import * as hubModule from './hub/main';
import { manifest as terminalManifest } from './terminal/manifest';
import * as terminalModule from './terminal/main';
import { manifest as automationsManifest } from './automations/manifest';
import * as automationsModule from './automations/main';
import { manifest as filesManifest } from './files/manifest';
import * as filesModule from './files/main';
import { manifest as issuesManifest } from './issues/manifest';
import * as issuesModule from './issues/main';
import { manifest as voiceChatManifest } from './voice-chat/manifest';
import * as voiceChatModule from './voice-chat/main';

export interface BuiltinPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

export function getBuiltinPlugins(): BuiltinPlugin[] {
  return [
    { manifest: hubManifest, module: hubModule },
    { manifest: terminalManifest, module: terminalModule },
    { manifest: automationsManifest, module: automationsModule },
    { manifest: filesManifest, module: filesModule },
    { manifest: issuesManifest, module: issuesModule },
    { manifest: voiceChatManifest, module: voiceChatModule },
  ];
}
