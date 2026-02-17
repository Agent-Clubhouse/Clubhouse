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
import { manifest as wikiManifest } from './wiki/manifest';
import * as wikiModule from './wiki/main';
import { manifest as kanbossManifest } from './kanboss/manifest';
import * as kanbossModule from './kanboss/main';

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
    { manifest: automationsManifest, module: automationsModule },
    { manifest: filesManifest, module: filesModule },
    { manifest: issuesManifest, module: issuesModule },
    { manifest: wikiManifest, module: wikiModule },
    { manifest: kanbossManifest, module: kanbossModule },
  ];
}

/** Returns the set of builtin plugin IDs that should be auto-enabled on first install. */
export function getDefaultEnabledIds(): ReadonlySet<string> {
  return DEFAULT_ENABLED_IDS;
}
