/**
 * The Dispatcher's first-run setup (#3047): three steps (name and look,
 * Behavior and Runs on, personality) shown in its own view the first time it
 * is opened. Upgrading users see it once too, prefilled with what they have.
 * "Set up later" keeps the defaults (the default name, Standard and Concise)
 * and setup stays reachable from its chat and menu.
 *
 * The app's welcome (#2814) teaches what the Dispatcher is; this is only its
 * own setup, so it says nothing the welcome says.
 */

import { isDispatcherBehavior, type DispatcherBehavior } from './dispatcher-behavior';
import { cleanDispatcherName, normalizeDispatcherPersonality, type DispatcherPersonality } from './dispatcher-personality';
import { ICON_DATA_URL_MAX_LENGTH } from './icon-limits';

/**
 * - `pending`: not set up yet. Opening its view shows setup.
 * - `later`: the user chose Set up later. The chat offers setup again.
 * - `done`: set up, or the offer was put away.
 */
export const DISPATCHER_SETUP_STATUSES = ['pending', 'later', 'done'] as const;
export type DispatcherSetupStatus = (typeof DISPATCHER_SETUP_STATUSES)[number];

export interface DispatcherSetupState {
  status: DispatcherSetupStatus;
  /**
   * It existed before this version first ran: setup is prefilled with what it
   * has and says, once, that it now remembers things.
   */
  upgrade: boolean;
}

export function isSetupStatus(value: unknown): value is DispatcherSetupStatus {
  return (DISPATCHER_SETUP_STATUSES as readonly unknown[]).includes(value);
}

/** What the state reports before anything is decided: nothing to show. */
export const NO_DISPATCHER_SETUP: DispatcherSetupState = { status: 'done', upgrade: false };

/** A saved value, or null when there is none to read. Never throws. */
export function normalizeSetupState(value: unknown): DispatcherSetupState | null {
  if (!value || typeof value !== 'object') return null;
  const { status, upgrade } = value as { status?: unknown; upgrade?: unknown };
  if (!isSetupStatus(status)) return null;
  return { status, upgrade: upgrade === true };
}

/** What setup saves when the user finishes it. */
export interface DispatcherSetupInput {
  name: string;
  /** An AGENT_COLORS id. */
  color: string;
  /** A new image as a data URL, null to remove the one it has, or left out to keep it. */
  image?: string | null;
  /** The provider it runs on (an orchestrator id). */
  provider: string;
  behavior: DispatcherBehavior;
  personality: DispatcherPersonality;
}

/** Try it out's request: the choices so far, nothing saved yet. */
export interface TryItOutRequest {
  name: string;
  provider: string;
  behavior: DispatcherBehavior;
  personality: DispatcherPersonality;
}

export type TryItOutResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** A setup input from the renderer, checked. Throws with a plain message for anything unusable. */
export function cleanSetupInput(value: unknown): DispatcherSetupInput {
  if (!value || typeof value !== 'object') throw new Error('Setup sent nothing to save.');
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? cleanDispatcherName(raw.name) : '';
  if (!name) throw new Error('Give it a name.');
  if (typeof raw.color !== 'string' || !raw.color) throw new Error('Pick a color.');
  if (typeof raw.provider !== 'string' || !raw.provider) throw new Error('Pick what it runs on.');
  if (!isDispatcherBehavior(raw.behavior)) throw new Error('Pick Light, Standard or Thorough.');
  let image: string | null | undefined;
  if (raw.image === null) image = null;
  else if (typeof raw.image === 'string') {
    if (!raw.image.startsWith('data:image/') || raw.image.length > ICON_DATA_URL_MAX_LENGTH) throw new Error('That image can’t be used.');
    image = raw.image;
  }
  return {
    name,
    color: raw.color,
    ...(image !== undefined && { image }),
    provider: raw.provider,
    behavior: raw.behavior,
    personality: normalizeDispatcherPersonality(raw.personality),
  };
}

/** A Try it out request from the renderer, checked. Throws with a plain message for anything unusable. */
export function cleanTryItOutRequest(value: unknown): TryItOutRequest {
  if (!value || typeof value !== 'object') throw new Error('Nothing to try.');
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== 'string' || !raw.provider) throw new Error('Pick what it runs on.');
  if (!isDispatcherBehavior(raw.behavior)) throw new Error('Pick Light, Standard or Thorough.');
  return {
    name: typeof raw.name === 'string' ? cleanDispatcherName(raw.name) : '',
    provider: raw.provider,
    behavior: raw.behavior,
    personality: normalizeDispatcherPersonality(raw.personality),
  };
}
