import type { PluginManifest, PluginModule } from '../../../shared/plugin-types';
import { manifest as hubManifest } from './hub/manifest';
import * as hubModule from './hub/main';
import { manifest as terminalManifest } from './terminal/manifest';
import * as terminalModule from './terminal/main';
import { manifest as filesManifest } from './files/manifest';
import * as filesModule from './files/main';

export interface BuiltinPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

/** Plugin IDs that are enabled by default in a fresh install. */
const DEFAULT_ENABLED_IDS: ReadonlySet<string> = new Set([
  'hub',
  'terminal',
  'files',
]);

export function getBuiltinPlugins(): BuiltinPlugin[] {
  return [
    { manifest: hubManifest, module: hubModule },
    { manifest: terminalManifest, module: terminalModule },
    { manifest: filesManifest, module: filesModule },
  ];
}

/** Returns the set of builtin plugin IDs that should be auto-enabled on first install. */
export function getDefaultEnabledIds(): ReadonlySet<string> {
  return DEFAULT_ENABLED_IDS;
}
