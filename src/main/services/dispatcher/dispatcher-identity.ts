/**
 * One identity over the Dispatcher's two agents (#3036). The chat the user
 * talks to and the coordinator that does the work share a name, a look, a CLI
 * and the settings Settings > Dispatcher shows. Each is a durable agent with
 * its own record, so whichever record a person changes (Settings > Dispatcher
 * edits the coordinator's, the chat's own details or a phone edit the chat's)
 * is copied onto the other. The last change wins.
 *
 * Until Behavior (#3045) gives each its own model, the model is shared too.
 * Session ids, sleep records and anything else per agent are never copied.
 */
import type { DurableAgentConfig, DurableConfigUpdates } from '../../../shared/types';

/** What updateDurable takes: name and look. */
export interface IdentityUpdates {
  name?: string;
  color?: string;
  icon?: string | null;
  emoji?: string | null;
}

export interface MirrorUpdates {
  identity: IdentityUpdates;
  config: DurableConfigUpdates;
}

/** A model left out and 'default' both mean the CLI's default. */
function modelOf(config: DurableAgentConfig): string {
  return config.model && config.model !== 'default' ? config.model : 'default';
}

/**
 * What to write to `to` so it matches `from` in everything the identity
 * shares. Empty when they already match, which is what stops a copy from
 * bouncing back.
 */
export function mirrorUpdates(from: DurableAgentConfig, to: DurableAgentConfig): MirrorUpdates {
  const identity: IdentityUpdates = {};
  const config: DurableConfigUpdates = {};

  if (from.name !== to.name) identity.name = from.name;
  if (from.color !== to.color) identity.color = from.color;
  // A record has an emoji or an image icon, never both: setting an emoji clears the icon.
  if ((from.icon ?? null) !== (to.icon ?? null)) identity.icon = from.icon ?? null;
  if ((from.emoji ?? null) !== (to.emoji ?? null)) identity.emoji = from.emoji ?? null;

  if (from.orchestrator && from.orchestrator !== to.orchestrator) config.orchestrator = from.orchestrator;
  if (modelOf(from) !== modelOf(to)) config.model = modelOf(from);
  if ((from.contextWindow ?? null) !== (to.contextWindow ?? null)) config.contextWindow = from.contextWindow ?? null;
  if ((from.runtimeMode ?? null) !== (to.runtimeMode ?? null)) config.runtimeMode = from.runtimeMode ?? null;
  if ((from.idleSleep ?? null) !== (to.idleSleep ?? null)) config.idleSleep = from.idleSleep ?? null;
  // Access sets the legacy flag too; a record from before Access (#2761) has only the flag.
  if (from.access) {
    if (from.access !== to.access) config.access = from.access;
  } else if (from.freeAgentMode !== undefined && from.freeAgentMode !== to.freeAgentMode) {
    config.freeAgentMode = from.freeAgentMode;
  }
  return { identity, config };
}

export function isEmptyMirror({ identity, config }: MirrorUpdates): boolean {
  return Object.keys(identity).length === 0 && Object.keys(config).length === 0;
}
