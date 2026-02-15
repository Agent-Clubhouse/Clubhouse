import type { PluginManifest, PluginModule } from '../../../shared/plugin-types';
import { manifest as hubManifest } from './hub/manifest';
import * as hubModule from './hub/main';
import { manifest as terminalManifest } from './terminal/manifest';
import * as terminalModule from './terminal/main';
import { manifest as automationsManifest } from './automations/manifest';
import * as automationsModule from './automations/main';
import { manifest as filesManifest } from './files/manifest';
import * as filesModule from './files/main';

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
  ];
}
