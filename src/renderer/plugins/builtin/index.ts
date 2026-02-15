import type { PluginManifest, PluginModule } from '../../../shared/plugin-types';
import { manifest as helloWorldManifest } from './hello-world/manifest';
import * as helloWorldModule from './hello-world/main';

export interface BuiltinPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

export function getBuiltinPlugins(): BuiltinPlugin[] {
  return [
    { manifest: helloWorldManifest, module: helloWorldModule },
  ];
}
