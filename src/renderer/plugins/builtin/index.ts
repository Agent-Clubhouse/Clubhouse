import type { PluginManifest, PluginModule } from '../../../shared/plugin-types';
import { manifest as helloWorldManifest } from './hello-world/manifest';
import * as helloWorldModule from './hello-world/main';
import { manifest as hubManifest } from './hub/manifest';
import * as hubModule from './hub/main';

export interface BuiltinPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

export function getBuiltinPlugins(): BuiltinPlugin[] {
  return [
    { manifest: helloWorldManifest, module: helloWorldModule },
    { manifest: hubManifest, module: hubModule },
  ];
}
