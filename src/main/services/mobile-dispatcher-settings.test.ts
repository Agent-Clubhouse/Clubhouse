import { beforeEach, describe, expect, it, vi } from 'vitest';

/** `chat` is the Dispatcher's chat, the agent a phone knows it by (#3036). */
const S = vi.hoisted(() => ({
  enabled: true,
  running: false,
  chat: null as Record<string, unknown> | null,
  level: 'standard' as string,
  auto: { ready: true } as Record<string, unknown>,
  models: { byHand: false, chat: null, work: null } as Record<string, unknown>,
  personality: { preset: 'concise', text: 'Be short and direct.' } as { preset: string; text: string },
}));

vi.mock('./dispatcher/dispatcher-service', () => ({
  DISPATCHER_NAME: 'Dispatcher',
  getDispatcherChatPath: () => '/base/dispatcher-chat',
  getDispatcherChatConfig: () => S.chat,
  getDispatcherState: () => ({
    enabled: S.enabled, agentId: S.chat ? 'durable_coordinator' : null, chatAgentId: (S.chat?.id as string) ?? null,
    behavior: { level: S.level, provider: 'claude-code', auto: S.auto }, models: S.models, personality: S.personality,
  }),
  setDispatcherBehavior: vi.fn(async (level: string) => { S.level = level; }),
  setDispatcherModels: vi.fn(async () => ({})),
  setDispatcherPersonality: vi.fn(async (p: { preset: string; text: string }) => { S.personality = p; }),
}));
vi.mock('../window-chrome', () => ({ newChromeEnabled: () => true }));
vi.mock('./agent-config', () => ({ updateDurable: vi.fn(async () => undefined) }));
vi.mock('./agent-system', () => ({ isAgentRunning: vi.fn(() => S.running) }));
vi.mock('../orchestrators', () => ({ getProvider: (id: string) => (id === 'claude-code' ? { displayName: 'Claude Code' } : undefined) }));
vi.mock('./dispatcher/dispatcher-clear-chat', () => ({ clearDispatcherChat: vi.fn(async () => ({ cleared: 'next_start' })) }));
vi.mock('./dispatcher/dispatcher-forget', () => ({ forgetEverything: vi.fn(async () => ({ removed: 1, heldNews: 2 })) }));
const USAGE = vi.hoisted(() => ({ day: '2027-01-15', conversations: { turns: 3 }, background: { turns: 1 } }));
vi.mock('./dispatcher/dispatcher-usage', () => ({ getDispatcherUsageSplit: () => USAGE }));

import * as agentConfig from './agent-config';
import * as dispatcher from './dispatcher/dispatcher-service';
import { clearDispatcherChat } from './dispatcher/dispatcher-clear-chat';
import { forgetEverything } from './dispatcher/dispatcher-forget';
import {
  buildDispatcherSettings, clearDispatcherChatFromPhone, forgetDispatcherFromPhone, setDispatcherModelsFromPhone, updateDispatcherFromPhone,
} from './mobile-dispatcher-settings';
import { MODELS_BY_HAND_NOTE } from '../../shared/dispatcher-behavior';
import { PERSONALITY_PRESET_TEXT, PERSONALITY_TEXT_MAX } from '../../shared/dispatcher-personality';
import type { MobileCommand } from '../../shared/mobile-control';

const PHONE = 'phone-fingerprint';
const allow = () => {};
const settings = (principal: string | undefined = PHONE) => buildDispatcherSettings(principal)!;
async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (e) { return e as { code: string; statusCode: number; detail?: string }; }
  throw new Error('expected a refusal');
}
const setModels = (fields: Record<string, unknown>) =>
  ({ version: 1, commandId: 'c1', epoch: 'e1', type: 'dispatcher.setModels', ...fields }) as Extract<MobileCommand, { type: 'dispatcher.setModels' }>;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(S, {
    enabled: true, running: false, level: 'standard', auto: { ready: true },
    chat: { id: 'durable_d', name: 'Dispatcher', color: 'indigo', createdAt: '2026-01-01', lastSessionId: 'sess_1' },
    models: { byHand: false, chat: null, work: null },
    personality: { preset: 'concise', text: PERSONALITY_PRESET_TEXT.concise },
  });
});

describe('the Dispatcher settings route (#3206)', () => {
  it('is null while the Dispatcher is off or not created', () => {
    S.enabled = false;
    expect(buildDispatcherSettings(PHONE)).toBeNull();
    S.enabled = true;
    S.chat = null;
    expect(buildDispatcherSettings(PHONE)).toBeNull();
  });

  it('reads Behavior, models, identity, personality, usage and what it no longer honors', () => {
    const read = settings();
    expect(read.agentId).toBe('durable_d');
    expect(read.behavior).toEqual({
      value: 'standard', editable: 'always', applies: 'now', setsModels: true, auto: { ready: true }, note: null,
      choices: [
        { id: 'light', label: 'Light', description: 'Fast models, and it doesn’t check in on its own. Keeps usage low.' },
        { id: 'standard', label: 'Standard', description: 'Balanced models. Checks in on your agents occasionally.' },
        { id: 'thorough', label: 'Thorough', description: 'The strongest models for the work. Checks in frequently.' },
      ],
    });
    expect(read.models).toMatchObject({
      byHand: false, editable: 'always',
      applies: { provider: 'next_start', model: 'now_or_next_start', effort: 'now_or_next_start', contextWindow: 'next_start' },
      roles: [
        { id: 'chat', label: 'Talking with you', help: 'Its replies to you in its chat.', pick: null },
        { id: 'work', label: 'Working in the background', help: 'The work you hand it, its check-ins and memory upkeep.', pick: null },
      ],
    });
    expect(read.identity).toEqual({
      name: { value: 'Dispatcher', editable: 'always', maxLength: 40 }, color: { value: 'indigo', editable: 'always' },
      emoji: { value: null, editable: 'always' }, hasImageIcon: false,
    });
    expect(read.personality).toMatchObject({ value: { preset: 'concise', text: PERSONALITY_PRESET_TEXT.concise }, editable: 'always', applies: 'next_start', maxLength: PERSONALITY_TEXT_MAX });
    expect(read.personality.presets.map((p) => [p.id, p.text === null])).toEqual([['friendly', false], ['concise', false], ['detailed', false], ['custom', true]]);
    expect(read.usage).toBe(USAGE);
    expect(read.notHonored).toEqual([
      { setting: 'model', reason: 'behavior' }, { setting: 'contextWindow', reason: 'behavior' },
      { setting: 'runtime', reason: 'not_offered' }, { setting: 'freeAgentMode', reason: 'not_offered' }, { setting: 'access', reason: 'not_offered' },
    ]);
  });

  it('says where Auto can\'t give a level its models', () => {
    S.auto = { ready: false, code: 'auto_not_supported' };
    expect(settings().behavior).toMatchObject({ auto: { ready: false, code: 'auto_not_supported' }, note: expect.stringContaining('Auto doesn’t support Claude Code yet') });
  });

  it('with the models chosen by hand: Behavior sets only how often it checks in, and CLI, model and context are honored (#3191)', () => {
    const pick = { provider: 'claude-code', model: 'opus', effort: 'high', contextWindow: null };
    S.models = { byHand: true, chat: pick, work: { ...pick, model: 'sonnet' } };
    const read = settings();
    expect(read.behavior).toMatchObject({ setsModels: false, note: MODELS_BY_HAND_NOTE });
    expect(read.behavior.choices[0].description).toBe('Doesn’t check in on its own. Keeps usage low.');
    expect(read.models.roles.map((r) => r.pick?.model)).toEqual(['opus', 'sonnet']);
    expect(read.notHonored.map((n) => n.setting)).toEqual(['runtime', 'freeAgentMode', 'access']);
  });

  it('gives each phone its own confirmation for each reset, and none without a client certificate', () => {
    const mine = settings();
    expect(mine.clearChat.expectedState).toMatch(/^[0-9a-f]{64}$/);
    expect(mine.forgetEverything.expectedState).toMatch(/^[0-9a-f]{64}$/);
    expect(mine.clearChat.expectedState).not.toBe(mine.forgetEverything.expectedState);
    expect(settings('other-phone').clearChat.expectedState).not.toBe(mine.clearChat.expectedState);
    expect(buildDispatcherSettings(undefined)).toMatchObject({ clearChat: { expectedState: null }, forgetEverything: { expectedState: null } });
  });

  it('says whether Clear chat starts over now or at the next start', () => {
    expect(settings().clearChat.applies).toBe('next_start');
    S.running = true;
    expect(settings().clearChat.applies).toBe('now');
  });
});

describe('dispatcher.update (#3206)', () => {
  it('changes Behavior, name, color, emoji and personality, and answers with fresh settings', async () => {
    const result = await updateDispatcherFromPhone({ behavior: 'thorough', name: '  Robin ', color: 'rose', emoji: '🦊', personality: { preset: 'friendly' } }, PHONE, allow);
    expect(dispatcher.setDispatcherBehavior).toHaveBeenCalledWith('thorough');
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/base/dispatcher-chat', 'durable_d', { name: 'Robin', color: 'rose', emoji: '🦊' });
    expect(dispatcher.setDispatcherPersonality).toHaveBeenCalledWith({ preset: 'friendly', text: PERSONALITY_PRESET_TEXT.friendly });
    expect(result).toMatchObject({ behavior: { value: 'thorough' }, personality: { value: { preset: 'friendly' } } });
  });
  it('makes edited text Custom, keeps a preset\'s own text on that preset, and reads empty text as Concise', async () => {
    await updateDispatcherFromPhone({ personality: { text: 'Talk like a pirate.' } }, PHONE, allow);
    await updateDispatcherFromPhone({ personality: { text: PERSONALITY_PRESET_TEXT.detailed } }, PHONE, allow);
    await updateDispatcherFromPhone({ personality: { preset: 'custom' } }, PHONE, allow);
    await updateDispatcherFromPhone({ personality: { text: '   ' } }, PHONE, allow);
    expect(vi.mocked(dispatcher.setDispatcherPersonality).mock.calls.map((c) => c[0])).toEqual([
      { preset: 'custom', text: 'Talk like a pirate.' },
      { preset: 'detailed', text: PERSONALITY_PRESET_TEXT.detailed },
      { preset: 'custom', text: PERSONALITY_PRESET_TEXT.detailed },
      { preset: 'concise', text: PERSONALITY_PRESET_TEXT.concise },
    ]);
  });
  it('checks everything before writing anything', async () => {
    expect(await refusal(updateDispatcherFromPhone({ behavior: 'thorough', color: 'chartreuse' }, PHONE, allow))).toMatchObject({ code: 'invalid_color', statusCode: 400 });
    expect(await refusal(updateDispatcherFromPhone({ behavior: 'turbo' }, PHONE, allow))).toMatchObject({ code: 'invalid_behavior', statusCode: 400 });
    expect(await refusal(updateDispatcherFromPhone({ name: ' \n ', behavior: 'light' }, PHONE, allow))).toMatchObject({ code: 'invalid_name', statusCode: 400 });
    expect(await refusal(updateDispatcherFromPhone({ personality: { preset: 'pirate' } }, PHONE, allow))).toMatchObject({ code: 'invalid_personality' });
    expect(await refusal(updateDispatcherFromPhone({ personality: { text: 'x'.repeat(PERSONALITY_TEXT_MAX + 1) } }, PHONE, allow))).toMatchObject({ code: 'invalid_personality' });
    expect(dispatcher.setDispatcherBehavior).not.toHaveBeenCalled();
    expect(agentConfig.updateDurable).not.toHaveBeenCalled();
    expect(dispatcher.setDispatcherPersonality).not.toHaveBeenCalled();
  });
  it('writes no name that is already its name, and rechecks authorization first', async () => {
    await updateDispatcherFromPhone({ name: 'Dispatcher' }, PHONE, allow);
    expect(agentConfig.updateDurable).not.toHaveBeenCalled();
    const revoked = () => { throw new Error('authorization_revoked'); };
    await expect(updateDispatcherFromPhone({ behavior: 'light' }, PHONE, revoked)).rejects.toThrow('authorization_revoked');
    expect(dispatcher.setDispatcherBehavior).not.toHaveBeenCalled();
  });
  it('is 409 dispatcher_off while it is off', async () => {
    S.enabled = false;
    expect(await refusal(updateDispatcherFromPhone({ behavior: 'light' }, PHONE, allow))).toMatchObject({ code: 'dispatcher_off', statusCode: 409 });
  });
});

describe('dispatcher.setModels (#3191, #3206)', () => {
  it('turns Choose models yourself on and changes one job\'s pick through the desktop service', async () => {
    await setDispatcherModelsFromPhone(setModels({ byHand: true }), PHONE, allow);
    await setDispatcherModelsFromPhone(setModels({ role: 'work', model: 'opus', effort: null }), PHONE, allow);
    expect(vi.mocked(dispatcher.setDispatcherModels).mock.calls.map((c) => c[0])).toEqual([{ byHand: true }, { role: 'work', model: 'opus', effort: null }]);
  });
  it('refuses a malformed change with 400 invalid_models and the reason, writing nothing', async () => {
    expect(await refusal(setDispatcherModelsFromPhone(setModels({ role: 'boss', model: 'opus' }), PHONE, allow))).toMatchObject({ code: 'invalid_models', statusCode: 400, detail: 'role must be chat or work.' });
    expect(await refusal(setDispatcherModelsFromPhone(setModels({ byHand: true, role: 'chat' }), PHONE, allow))).toMatchObject({ code: 'invalid_models' });
    expect(dispatcher.setDispatcherModels).not.toHaveBeenCalled();
  });
  it('passes on a refusal from the service as 409 models_refused with its sentence', async () => {
    vi.mocked(dispatcher.setDispatcherModels).mockRejectedValueOnce(new Error('Turn on Choose models yourself first.'));
    expect(await refusal(setDispatcherModelsFromPhone(setModels({ role: 'chat', model: 'opus' }), PHONE, allow))).toMatchObject({
      code: 'models_refused', statusCode: 409, detail: 'Turn on Choose models yourself first.',
    });
  });
});

describe('Clear chat and Forget everything, each confirmed (#3206)', () => {
  it('clears the chat with this phone\'s Clear chat confirmation, once', async () => {
    const { expectedState } = settings().clearChat;
    expect(await clearDispatcherChatFromPhone(expectedState!, PHONE, allow)).toEqual({ cleared: 'next_start' });
    expect(clearDispatcherChat).toHaveBeenCalledTimes(1);
    // Used: a second command with the same confirmation is stale (an identical retry gets the receipt instead).
    expect(await refusal(clearDispatcherChatFromPhone(expectedState!, PHONE, allow))).toMatchObject({ code: 'stale_state', statusCode: 409 });
    expect(clearDispatcherChat).toHaveBeenCalledTimes(1);
  });
  it('refuses another phone\'s confirmation, Forget everything\'s, or anything made up', async () => {
    const mine = settings();
    for (const [principal, token] of [['other-phone', mine.clearChat.expectedState], [PHONE, mine.forgetEverything.expectedState], [PHONE, 'yes']] as const) {
      expect(await refusal(clearDispatcherChatFromPhone(token!, principal, allow))).toMatchObject({ code: 'stale_state' });
    }
    expect(clearDispatcherChat).not.toHaveBeenCalled();
  });
  it('goes stale when the conversation it would end changed, or it woke or slept', async () => {
    const asleep = settings().clearChat.expectedState!;
    S.running = true;
    expect(await refusal(clearDispatcherChatFromPhone(asleep, PHONE, allow))).toMatchObject({ code: 'stale_state' });
    const awake = settings().clearChat.expectedState!;
    S.chat = { ...S.chat, lastSessionId: 'sess_2' };
    expect(await refusal(clearDispatcherChatFromPhone(awake, PHONE, allow))).toMatchObject({ code: 'stale_state' });
    expect(clearDispatcherChat).not.toHaveBeenCalled();
  });
  it('reports a clear that fails as 409 clear_failed with the reason', async () => {
    vi.mocked(clearDispatcherChat).mockRejectedValueOnce(new Error('The Dispatcher\'s conversation can\'t be cleared right now.'));
    expect(await refusal(clearDispatcherChatFromPhone(settings().clearChat.expectedState!, PHONE, allow))).toMatchObject({ code: 'clear_failed', statusCode: 409 });
  });
  it('forgets everything with this phone\'s Forget everything confirmation, once, and never with Clear chat\'s', async () => {
    const read = settings();
    expect(await refusal(forgetDispatcherFromPhone(read.clearChat.expectedState!, PHONE, allow))).toMatchObject({ code: 'stale_state' });
    expect(forgetEverything).not.toHaveBeenCalled();
    expect(await forgetDispatcherFromPhone(read.forgetEverything.expectedState!, PHONE, allow)).toEqual({ removed: 1, heldNews: 2 });
    expect(await refusal(forgetDispatcherFromPhone(read.forgetEverything.expectedState!, PHONE, allow))).toMatchObject({ code: 'stale_state' });
    expect(forgetEverything).toHaveBeenCalledTimes(1);
  });
  it('rechecks authorization before acting, and is 409 dispatcher_off while it is off', async () => {
    const { forgetEverything: confirm } = settings();
    const revoked = () => { throw new Error('authorization_revoked'); };
    await expect(forgetDispatcherFromPhone(confirm.expectedState!, PHONE, revoked)).rejects.toThrow('authorization_revoked');
    expect(forgetEverything).not.toHaveBeenCalled();
    S.enabled = false;
    expect(await refusal(forgetDispatcherFromPhone(confirm.expectedState!, PHONE, allow))).toMatchObject({ code: 'dispatcher_off' });
  });
});
