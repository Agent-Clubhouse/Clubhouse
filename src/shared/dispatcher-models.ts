/**
 * Choose models yourself (#3191): a switch in Settings > Dispatcher that hands
 * the choice of model from Behavior to the user. On, each of the Dispatcher's
 * two jobs, talking with you (`chat`) and working in the background (`work`),
 * runs on the provider, model, effort and context the user picked, and
 * Behavior only sets how often it checks in and keeps its memory. Off, Behavior
 * gives both their models from the Auto mapping, as before.
 *
 * Saved in dispatcher-settings.json. The picks are kept when the switch goes
 * off, so turning it back on restores them.
 */

import { isEffortValue } from './agent-helpers';
import type { DispatcherRole } from './dispatcher-behavior';

/** One job's pick. `model` 'default', `effort` null and `contextWindow` null each mean the CLI's default. */
export interface DispatcherRoleModel {
  provider: string;
  model: string;
  effort: string | null;
  contextWindow: string | null;
}

/** What dispatcher-settings.json holds under `models`. */
export interface SavedDispatcherModels {
  byHand?: boolean;
  chat?: DispatcherRoleModel;
  work?: DispatcherRoleModel;
}

/** What main reports on DispatcherState. Both picks are set while `byHand` is on. */
export interface DispatcherModelsState {
  byHand: boolean;
  chat: DispatcherRoleModel | null;
  work: DispatcherRoleModel | null;
}

export const DEFAULT_DISPATCHER_MODELS_STATE: DispatcherModelsState = { byHand: false, chat: null, work: null };

/** The words for each job. They name what it does for the user, never how it is built. */
export const DISPATCHER_ROLE_LABELS: Readonly<Record<DispatcherRole, { label: string; help: string }>> = {
  chat: { label: 'Talking with you', help: 'Its replies to you in its chat.' },
  work: { label: 'Working in the background', help: 'The work you hand it, its check-ins and memory upkeep.' },
};

/** When a change to a pick applies. */
export const DISPATCHER_MODELS_APPLY_NOTE = 'A new model or effort applies at once where the CLI allows, otherwise at its next start. A new provider or context applies at its next start.';

/** A change from Settings or a phone: the switch, or some of one job's fields. */
export type DispatcherModelsUpdate =
  | { byHand: boolean }
  | { role: DispatcherRole; provider?: string; model?: string; effort?: string | null; contextWindow?: string | null };

const MAX_ID = 200;

function cleanId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID) throw new Error(`${field} must be a short, non-empty string.`);
  return value.trim();
}

/** A saved pick, or null for anything that isn't one. Never throws. */
export function normalizeRoleModel(value: unknown): DispatcherRoleModel | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.provider !== 'string' || !v.provider) return null;
  return {
    provider: v.provider,
    model: typeof v.model === 'string' && v.model ? v.model : 'default',
    effort: isEffortValue(v.effort) ? v.effort : null,
    contextWindow: typeof v.contextWindow === 'string' && v.contextWindow ? v.contextWindow : null,
  };
}

/** The saved values as main reports them. Missing or broken reads as off. */
export function normalizeDispatcherModels(value: unknown): DispatcherModelsState {
  if (!value || typeof value !== 'object') return DEFAULT_DISPATCHER_MODELS_STATE;
  const v = value as Record<string, unknown>;
  return { byHand: v.byHand === true, chat: normalizeRoleModel(v.chat), work: normalizeRoleModel(v.work) };
}

/** Checks a change from the renderer or a phone. Throws with a sentence for anything else. */
export function cleanModelsUpdate(value: unknown): DispatcherModelsUpdate {
  if (!value || typeof value !== 'object') throw new Error('Send the switch or one job\'s fields.');
  const v = value as Record<string, unknown>;
  if ('byHand' in v) {
    if (typeof v.byHand !== 'boolean') throw new Error('byHand must be true or false.');
    if ('role' in v) throw new Error('Send the switch and a job\'s fields separately.');
    return { byHand: v.byHand };
  }
  if (v.role !== 'chat' && v.role !== 'work') throw new Error('role must be chat or work.');
  const update: Extract<DispatcherModelsUpdate, { role: DispatcherRole }> = { role: v.role };
  if (v.provider !== undefined) update.provider = cleanId(v.provider, 'provider');
  if (v.model !== undefined) update.model = cleanId(v.model, 'model');
  if (v.effort !== undefined) {
    if (v.effort !== null && !isEffortValue(v.effort)) throw new Error(`${String(v.effort)} isn't an effort level.`);
    update.effort = v.effort as string | null;
  }
  if (v.contextWindow !== undefined) update.contextWindow = v.contextWindow === null ? null : cleanId(v.contextWindow, 'contextWindow');
  if (Object.keys(update).length === 1) throw new Error('Send at least one of provider, model, effort or contextWindow.');
  return update;
}

/**
 * A pick after a change, by the rules an agent's own settings follow: a new
 * provider goes back to its default model, effort and context, since none of
 * them mean anything to another CLI, and a new model clears the effort and
 * context, which were chosen for the old one. Fields sent with the change win.
 */
export function mergeRoleModel(current: DispatcherRoleModel, update: Omit<Extract<DispatcherModelsUpdate, { role: DispatcherRole }>, 'role'>): DispatcherRoleModel {
  const next = { ...current };
  if (update.provider !== undefined && update.provider !== current.provider) {
    next.provider = update.provider;
    next.model = 'default';
    next.effort = null;
    next.contextWindow = null;
  }
  if (update.model !== undefined && update.model !== next.model) {
    next.model = update.model;
    next.effort = null;
    next.contextWindow = null;
  }
  if (update.effort !== undefined) next.effort = update.effort;
  if (update.contextWindow !== undefined) next.contextWindow = update.contextWindow;
  return next;
}
