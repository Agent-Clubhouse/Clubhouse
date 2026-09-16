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
import { manifest as groupProjectManifest } from './group-project/manifest';
import * as groupProjectModule from './group-project/main';
import { manifest as agentQueueManifest } from './agent-queue/manifest';
import * as agentQueueModule from './agent-queue/main';
import { manifest as stickyNoteManifest } from './sticky-note/manifest';
import * as stickyNoteModule from './sticky-note/main';
import { manifest as goobersManifest } from './goobers/manifest';
import * as goobersModule from './goobers/main';

export interface BuiltinPlugin {
  manifest: PluginManifest;
  module: PluginModule;
}

/** Experimental feature flags that gate conditional built-in plugins. */
export interface ExperimentalFlags {
  sessions?: boolean;
  agentQueue?: boolean;
  goobers?: boolean;
  [key: string]: boolean | undefined;
}

/** True on the platform Goobers deliberately does not support (spec §2.6, §7.8). */
function isUnsupportedGoobersPlatform(): boolean {
  const w = typeof window !== 'undefined' ? (window as unknown as { clubhouse?: { platform?: string } }) : undefined;
  return w?.clubhouse?.platform === 'win32';
}

/** Plugin IDs that are always enabled by default in a fresh install. */
const BASE_DEFAULT_IDS = ['terminal', 'files', 'git', 'browser', 'review', 'canvas', 'group-project', 'sticky-note'];

/** Canvas sub-plugin IDs — hidden from the plugin list unless canvas is enabled. */
export const CANVAS_SUB_PLUGIN_IDS: ReadonlySet<string> = new Set(['group-project', 'agent-queue', 'sticky-note']);

/** Canvas sub-plugin IDs that are always loaded (not behind experimental flags). */
export const STABLE_CANVAS_SUB_PLUGIN_IDS: ReadonlySet<string> = new Set(['group-project', 'sticky-note']);

export function getBuiltinPlugins(experimentalFlags: ExperimentalFlags = {}): BuiltinPlugin[] {
  const plugins: BuiltinPlugin[] = [
    { manifest: hubManifest, module: hubModule },
    { manifest: terminalManifest, module: terminalModule },
    { manifest: filesManifest, module: filesModule },
    { manifest: browserManifest, module: browserModule },
    { manifest: gitManifest, module: gitModule },
    { manifest: canvasManifest, module: canvasModule },
    { manifest: reviewManifest, module: reviewModule },
    { manifest: groupProjectManifest, module: groupProjectModule },
    { manifest: stickyNoteManifest, module: stickyNoteModule },
  ];

  if (experimentalFlags.agentQueue) {
    plugins.push({ manifest: agentQueueManifest, module: agentQueueModule });
  }

  if (experimentalFlags.sessions) {
    plugins.push({ manifest: sessionsManifest, module: sessionsModule });
  }

  // Filtered at registration, not just gated in the service, so nothing
  // half-appears on an unsupported platform (spec §7.8).
  if (experimentalFlags.goobers && !isUnsupportedGoobersPlatform()) {
    plugins.push({ manifest: goobersManifest, module: goobersModule });
  }

  return plugins;
}

/** Returns the set of builtin plugin IDs that should be auto-enabled on first install. */
export function getDefaultEnabledIds(experimentalFlags: ExperimentalFlags = {}): ReadonlySet<string> {
  const ids = [...BASE_DEFAULT_IDS];
  if (experimentalFlags.sessions) {
    ids.push('sessions');
  }
  return new Set(ids);
}
