/**
 * Settings > Dispatcher from a phone (#3206): Behavior, Choose models
 * yourself (#3191), name and look, personality, today's usage split, and the
 * two resets, each behind its own confirmation. The writes go through the
 * same services Settings > Dispatcher uses, so the desktop and every phone
 * see the same state. See docs/mobile-control-v1.md#dispatcher-settings.
 *
 * Clear chat and Forget everything need the `expectedState` the settings
 * route gave this phone for that action, the precondition pattern
 * agent.providerChange uses: an opaque hash of what the confirmation showed,
 * bound to the phone. A token for one never confirms the other. Either goes
 * stale once its action runs from any surface (the services count them), when
 * the switch turns the Dispatcher off or on, and Forget everything's once the
 * memory has changed since it was read.
 */

import { createHash, randomUUID } from 'crypto';
import * as agentConfig from './agent-config';
import { isAgentRunning } from './agent-system';
import { getProvider } from '../orchestrators';
import * as dispatcher from './dispatcher/dispatcher-service';
import { clearDispatcherChat, getClearChatGeneration } from './dispatcher/dispatcher-clear-chat';
import { forgetEverything, getForgetGeneration, memoryFingerprint } from './dispatcher/dispatcher-forget';
import { getDispatcherUsageSplit } from './dispatcher/dispatcher-usage';
import { MobileControlError } from './mobile-control';
import { dispatcherProject } from './mobile-dispatcher';
import { AGENT_COLORS } from '../../shared/name-generator';
import {
  DISPATCHER_BEHAVIORS, DISPATCHER_BEHAVIOR_LABELS, DISPATCHER_ROLES, MODELS_BY_HAND_NOTE, behaviorAutoNote, behaviorDescription, isDispatcherBehavior,
} from '../../shared/dispatcher-behavior';
import { DISPATCHER_MODELS_APPLY_NOTE, DISPATCHER_ROLE_LABELS, cleanModelsUpdate } from '../../shared/dispatcher-models';
import {
  DISPATCHER_NAME_MAX, DISPATCHER_PERSONALITY_PRESETS, PERSONALITY_PRESET_LABELS, PERSONALITY_PRESET_TEXT, PERSONALITY_TEXT_MAX,
  cleanDispatcherName, cleanPersonalityText, isPersonalityPreset, normalizeDispatcherPersonality, presetForText, presetText, type DispatcherPersonality,
} from '../../shared/dispatcher-personality';
import { dispatcherNotHonored, type MobileCommand, type MobileDispatcherUpdate } from '../../shared/mobile-control';

type ConfirmedAction = 'clearChat' | 'forgetEverything';

/** Makes every token opaque to the phone, and unusable after the app restarts. */
let tokenSalt: string = randomUUID();

function token(action: ConfirmedAction, principal: string, parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify([tokenSalt, action, principal, ...parts])).digest('hex');
}

/** The Dispatcher's chat, the agent a phone knows it by, while it is on. Otherwise 409 dispatcher_off. */
function activeChat() {
  const state = dispatcher.getDispatcherState();
  const chat = dispatcher.getDispatcherChatConfig();
  if (!state.enabled || !chat) throw new MobileControlError('dispatcher_off', 409, 'rejected', 'The Dispatcher is turned off.');
  return { state, chat };
}

/**
 * What each confirmation is bound to: Clear chat to the conversation it ends
 * and every clear so far, Forget everything to the memory as it is now and
 * every forget so far. Both to each time its switch turned it off or on.
 */
function confirmationParts(action: ConfirmedAction, memory: Awaited<ReturnType<typeof memoryFingerprint>> | null): unknown[] {
  // Synchronous on purpose: the memory is read before, so the counters are read with nothing awaited
  // between them and the action, which bumps its counter before it awaits anything. Two commands
  // with one token can't both run.
  const { state, chat } = activeChat();
  const switched = dispatcher.getDispatcherSwitchGeneration();
  if (action === 'clearChat') return [switched, getClearChatGeneration(), chat.id, chat.lastSessionId ?? null, isAgentRunning(chat.id)];
  return [switched, getForgetGeneration(), state.agentId, memory];
}

const displayName = (provider: string): string => getProvider(provider)?.displayName ?? provider;

/**
 * `GET /api/v1/mobile/dispatcher/settings`: everything Settings > Dispatcher
 * shows besides its switch and connected agents. Null while it is off or not
 * created yet. Without a pinned client certificate there are no confirmation
 * tokens, since such a client can't send commands.
 */
export async function buildDispatcherSettings(principal: string | undefined) {
  const state = dispatcher.getDispatcherState();
  const chat = dispatcher.getDispatcherChatConfig();
  if (!state.enabled || !chat) return null;
  const { behavior, models, personality } = state;
  const byHand = models.byHand;
  const running = isAgentRunning(chat.id);
  const memory = principal ? await memoryFingerprint() : null;
  // Read after the await: the Dispatcher may have changed while the memory was read.
  const expected = (action: ConfirmedAction) => (principal && memory ? token(action, principal, confirmationParts(action, memory)) : null);
  const clearToken = expected('clearChat');
  const forgetToken = expected('forgetEverything');
  return {
    agentId: chat.id,
    behavior: {
      value: behavior.level,
      editable: 'always' as const,
      // Saved at once; the models it gives switch now where the CLI allows, otherwise at the next start.
      applies: 'now' as const,
      choices: DISPATCHER_BEHAVIORS.map((id) => ({ id, label: DISPATCHER_BEHAVIOR_LABELS[id].label, description: behaviorDescription(id, byHand) })),
      // With the models chosen by hand, Behavior only sets how often it checks in.
      setsModels: !byHand,
      auto: behavior.auto,
      note: byHand ? MODELS_BY_HAND_NOTE : behavior.provider ? behaviorAutoNote(behavior.auto, displayName(behavior.provider)) : null,
    },
    models: {
      byHand,
      editable: 'always' as const,
      note: DISPATCHER_MODELS_APPLY_NOTE,
      applies: { provider: 'next_start', model: 'now_or_next_start', effort: 'now_or_next_start', contextWindow: 'next_start' } as const,
      roles: DISPATCHER_ROLES.map((id) => ({ id, label: DISPATCHER_ROLE_LABELS[id].label, help: DISPATCHER_ROLE_LABELS[id].help, pick: models[id] })),
    },
    identity: {
      name: { value: chat.name, editable: 'always' as const, maxLength: DISPATCHER_NAME_MAX },
      color: { value: chat.color, editable: 'always' as const },
      emoji: { value: chat.emoji ?? null, editable: 'always' as const },
      hasImageIcon: !!chat.icon,
    },
    personality: {
      value: { preset: personality.preset, text: personality.text },
      editable: 'always' as const,
      // It is part of the chat's instructions, which a session reads when it starts.
      applies: 'next_start' as const,
      maxLength: PERSONALITY_TEXT_MAX,
      presets: DISPATCHER_PERSONALITY_PRESETS.map((id) => ({
        id, label: PERSONALITY_PRESET_LABELS[id].label, description: PERSONALITY_PRESET_LABELS[id].description,
        text: id === 'custom' ? null : PERSONALITY_PRESET_TEXT[id],
      })),
    },
    usage: getDispatcherUsageSplit(),
    notHonored: dispatcherNotHonored(byHand),
    clearChat: { expectedState: clearToken, applies: running ? 'now' as const : 'next_start' as const },
    forgetEverything: { expectedState: forgetToken },
  };
}
export type MobileDispatcherSettings = NonNullable<Awaited<ReturnType<typeof buildDispatcherSettings>>>;

function invalid(code: string, detail?: string): MobileControlError {
  return new MobileControlError(code, 400, 'rejected', detail);
}

/** A phone's personality change as the desktop field makes one: a preset fills the text, edited text is Custom. */
function nextPersonality(change: NonNullable<MobileDispatcherUpdate['personality']>, current: DispatcherPersonality): DispatcherPersonality {
  const { text } = change;
  if (change.preset !== undefined && !isPersonalityPreset(change.preset)) throw invalid('invalid_personality', `${String(change.preset)} isn't a personality preset.`);
  const preset = change.preset as DispatcherPersonality['preset'] | undefined;
  if (text !== undefined && typeof text !== 'string') throw invalid('invalid_personality', 'text must be a string.');
  if (typeof text === 'string' && text.length > PERSONALITY_TEXT_MAX) throw invalid('invalid_personality', `Keep it to ${PERSONALITY_TEXT_MAX} characters.`);
  if (text === undefined) {
    if (preset === undefined) throw invalid('invalid_personality', 'Send a preset or text.');
    return normalizeDispatcherPersonality({ preset, text: presetText(preset, current.text) });
  }
  // Text that isn't the named preset's own is the person's own: Custom, so the desktop never shows a preset beside other text.
  const named = preset === undefined ? presetForText(text) : preset !== 'custom' && PERSONALITY_PRESET_TEXT[preset] === cleanPersonalityText(text) ? preset : 'custom';
  // Empty text reads as the default, as on the desktop.
  return normalizeDispatcherPersonality({ preset: named, text });
}

/**
 * dispatcher.update: Behavior, name, color, emoji and personality, as
 * Settings > Dispatcher changes them. Everything is checked before anything
 * is written. The name and look go on its chat's record and are copied to
 * the rest of its identity.
 */
export async function updateDispatcherFromPhone(command: MobileDispatcherUpdate, principal: string, assertAuthorized: () => void) {
  const { state, chat } = activeChat();
  if (command.behavior !== undefined && !isDispatcherBehavior(command.behavior)) throw invalid('invalid_behavior', `${command.behavior} isn't a Behavior.`);
  const identity: { name?: string; color?: string; emoji?: string | null } = {};
  if (command.name !== undefined) {
    const name = cleanDispatcherName(command.name);
    if (!name) throw invalid('invalid_name');
    if (name !== chat.name) identity.name = name;
  }
  if (command.color !== undefined) {
    if (!AGENT_COLORS.some((c) => c.id === command.color)) throw invalid('invalid_color');
    identity.color = command.color;
  }
  if (command.emoji !== undefined) identity.emoji = command.emoji;
  const personality = command.personality !== undefined ? nextPersonality(command.personality, state.personality) : undefined;

  assertAuthorized();
  if (command.behavior !== undefined && isDispatcherBehavior(command.behavior)) await dispatcher.setDispatcherBehavior(command.behavior);
  if (Object.keys(identity).length > 0) await agentConfig.updateDurable(dispatcherProject().path, chat.id, identity);
  if (personality) await dispatcher.setDispatcherPersonality(personality);
  return buildDispatcherSettings(principal);
}

/**
 * dispatcher.setModels: Choose models yourself (#3191), the switch or one
 * job's provider, model, effort and context, through the service Settings >
 * Dispatcher uses. A pick its record refuses is not kept.
 */
export async function setDispatcherModelsFromPhone(command: Extract<MobileCommand, { type: 'dispatcher.setModels' }>, principal: string, assertAuthorized: () => void) {
  activeChat();
  const { type: _type, version: _version, commandId: _commandId, epoch: _epoch, ...fields } = command;
  let update: ReturnType<typeof cleanModelsUpdate>;
  try {
    update = cleanModelsUpdate(fields);
  } catch (err) {
    throw invalid('invalid_models', err instanceof Error ? err.message : undefined);
  }
  assertAuthorized();
  try {
    await dispatcher.setDispatcherModels(update);
  } catch (err) {
    // telemetry-exempt: the receipt carries the refusal; dispatcher-service logs what it changed.
    throw new MobileControlError('models_refused', 409, 'rejected', err instanceof Error ? err.message : undefined);
  }
  return buildDispatcherSettings(principal);
}

/**
 * The token this phone was given for the action, checked against the parts
 * just read; a different one is 409 stale_state and nothing happens. Callers
 * run the action with nothing awaited after this, so its counter moves first.
 */
function assertConfirmed(action: ConfirmedAction, principal: string, expectedState: string, parts: unknown[]): void {
  if (token(action, principal, parts) !== expectedState) {
    throw new MobileControlError('stale_state', 409, 'rejected', 'This changed since you were asked. Check again and confirm.');
  }
}

/**
 * dispatcher.clearChat: its conversation starts over, as Clear chat in its
 * menu does. Memory, its agents and their connections stay. `cleared` is
 * `now` for a running chat and `next_start` for a sleeping one.
 */
export async function clearDispatcherChatFromPhone(expectedState: string, principal: string, assertAuthorized: () => void) {
  assertConfirmed('clearChat', principal, expectedState, confirmationParts('clearChat', null));
  assertAuthorized();
  try {
    return await clearDispatcherChat();
  } catch (err) {
    // telemetry-exempt: the receipt carries the failure; clearDispatcherChat logs its own.
    throw new MobileControlError('clear_failed', 409, 'failed', err instanceof Error ? err.message : undefined);
  }
}

/**
 * dispatcher.forgetEverything: its memory goes and starts over empty, as
 * Settings > Dispatcher's Forget everything does. Its chat, agents,
 * connections and Actions stay.
 */
export async function forgetDispatcherFromPhone(expectedState: string, principal: string, assertAuthorized: () => void) {
  const memory = await memoryFingerprint();
  assertConfirmed('forgetEverything', principal, expectedState, confirmationParts('forgetEverything', memory));
  assertAuthorized();
  return forgetEverything();
}

/** For the contract fixtures, whose tokens must not change between runs. */
export function _setConfirmationSaltForTesting(salt: string): void {
  tokenSalt = salt;
}
