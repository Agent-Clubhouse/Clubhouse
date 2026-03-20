import type { PluginManifest, PluginModule } from '../../../shared/plugin-types';
import { manifest as hubManifest } from './hub/manifest';
import * as hubModule from './hub/main';
import { manifest as terminalManifest } from './terminal/manifest';
import * as terminalModule from './terminal/main';
import { manifest as filesManifest } from './files/manifest';
import * as filesModule from './files/main';
import { manifest as browserManifest } from './browser/manifest';
import * as browserModule from './browser/main';
import { manifest as gitManifest } from './git/manifest';
import * as gitModule from './git/main';
import { manifest as canvasManifest } from './canvas/manifest';
import * as canvasModule from './canvas/main';
import { manifest as sessionsManifest } from './sessions/manifest';
import * as sessionsModule from './sessions/main';
import { manifest as reviewManifest } from './review/manifest';
import * as reviewModule from './review/main';

export interface BuiltinPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

/** Experimental feature flags that gate conditional built-in plugins. */
export interface ExperimentalFlags {
  canvas?: boolean;
  sessions?: boolean;
  [key: string]: boolean | undefined;
}

/** Plugin IDs that are always enabled by default in a fresh install. */
const BASE_DEFAULT_IDS = ['hub', 'terminal', 'files', 'browser', 'git', 'review'];

export function getBuiltinPlugins(experimentalFlags: ExperimentalFlags = {}): BuiltinPlugin[] {
  const plugins: BuiltinPlugin[] = [
    { manifest: hubManifest, module: hubModule },
    { manifest: terminalManifest, module: terminalModule },
    { manifest: filesManifest, module: filesModule },
    { manifest: browserManifest, module: browserModule },
    { manifest: gitManifest, module: gitModule },
    { manifest: reviewManifest, module: reviewModule },
  ];

  if (experimentalFlags.canvas) {
    plugins.push({ manifest: canvasManifest, module: canvasModule });
  }

  if (experimentalFlags.sessions) {
    plugins.push({ manifest: sessionsManifest, module: sessionsModule });
  }

  return plugins;
}

/** Returns the set of builtin plugin IDs that should be auto-enabled on first install. */
export function getDefaultEnabledIds(experimentalFlags: ExperimentalFlags = {}): ReadonlySet<string> {
  const ids = [...BASE_DEFAULT_IDS];
  if (experimentalFlags.canvas) {
    ids.push('canvas');
  }
  if (experimentalFlags.sessions) {
    ids.push('sessions');
  }
  return new Set(ids);
}
