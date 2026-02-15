import type { PluginManifest, PluginModule } from '../../../shared/plugin-types';
import { manifest as helloWorldManifest } from './hello-world/manifest';
import * as helloWorldModule from './hello-world/main';
import { manifest as hubManifest } from './hub/manifest';
import * as hubModule from './hub/main';
import { manifest as terminalManifest } from './terminal/manifest';
import * as terminalModule from './terminal/main';

export interface BuiltinPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

export function getBuiltinPlugins(): BuiltinPlugin[] {
  return [
    { manifest: helloWorldManifest, module: helloWorldModule },
    { manifest: hubManifest, module: hubModule },
    { manifest: terminalManifest, module: terminalModule },
  ];
}
