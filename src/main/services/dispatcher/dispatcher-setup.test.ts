import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../settings-store', () => ({
  createSettingsStore: <T,>(_file: string, defaults: T) => {
    let value = { ...defaults };
    return {
      get: () => value,
      save: async (v: T) => { value = v; },
      update: async (fn: (c: T) => T) => { value = fn(value); return value; },
    };
  },
}));
vi.mock('../experimental-settings', () => ({ getSettings: () => ({}) }));
vi.mock('../../window-chrome', () => ({ newChromeEnabled: () => true }));
vi.mock('../helper-routing', () => ({ resolveAutoLevel: vi.fn() }));
// The real runner is never reached: every test stubs it, so no CLI runs and no tokens are spent.
vi.mock('../headless-prompt', () => ({ runHeadlessPrompt: vi.fn(async () => { throw new Error('a test reached the real runner'); }) }));
// "Contacts no agent": nothing that starts, wakes or messages one may be called.
vi.mock('../agent-system', () => ({ spawnAgent: vi.fn(), wakeAgent: vi.fn() }));
vi.mock('./dispatcher-channel', () => ({ deliverToDispatcher: vi.fn(), wakeAndDeliver: vi.fn() }));

import * as agentSystem from '../agent-system';
import * as channel from './dispatcher-channel';
import { runHeadlessPrompt } from '../headless-prompt';
import { updateSettings, getSettings } from './dispatcher-settings';
import {
  checkDispatcherBehavior,
  decideDispatcherSetup,
  getDispatcherPersonality,
  getDispatcherSetup,
  saveDispatcherPersonality,
  saveDispatcherSetupStatus,
  tryDispatcherPersonality,
  TRY_IT_OUT_TIMEOUT_MS,
} from './dispatcher-setup';
import { DEFAULT_DISPATCHER_PERSONALITY, PERSONALITY_PRESET_TEXT, TRY_IT_OUT_QUESTION } from '../../../shared/dispatcher-personality';
import type { DispatcherBehaviorModels } from '../../../shared/dispatcher-behavior';

const MODELS: DispatcherBehaviorModels = {
  ok: true,
  models: { chat: { model: 'sonnet', effort: 'medium' }, work: { model: 'opus', effort: 'high' } },
};

beforeEach(async () => {
  vi.clearAllMocks();
  await updateSettings(() => ({}));
});

describe('personality', () => {
  it('is Concise until a person picks, and saves a change once', async () => {
    expect(getDispatcherPersonality()).toEqual(DEFAULT_DISPATCHER_PERSONALITY);
    expect(await saveDispatcherPersonality({ preset: 'detailed', text: PERSONALITY_PRESET_TEXT.detailed })).toBe(true);
    expect(await saveDispatcherPersonality({ preset: 'detailed', text: PERSONALITY_PRESET_TEXT.detailed })).toBe(false);
    expect(getDispatcherPersonality().preset).toBe('detailed');
  });

  it('reads empty or unusable text as the default', async () => {
    await saveDispatcherPersonality({ preset: 'custom', text: '   ' });
    expect(getDispatcherPersonality()).toEqual(DEFAULT_DISPATCHER_PERSONALITY);
    await updateSettings((s) => ({ ...s, personality: 'loud' as never }));
    expect(getDispatcherPersonality()).toEqual(DEFAULT_DISPATCHER_PERSONALITY);
  });
});

describe('setup state', () => {
  it('shows nothing until decided, then decides once', async () => {
    expect(getDispatcherSetup()).toEqual({ status: 'done', upgrade: false });
    expect(await decideDispatcherSetup(true)).toBe(true);
    expect(getDispatcherSetup()).toEqual({ status: 'pending', upgrade: true });
    expect(await decideDispatcherSetup(false)).toBe(false);
    expect(getDispatcherSetup()).toEqual({ status: 'pending', upgrade: true });
  });

  it('keeps whether it was an upgrade when the status moves on', async () => {
    await decideDispatcherSetup(true);
    await saveDispatcherSetupStatus('later');
    expect(getDispatcherSetup()).toEqual({ status: 'later', upgrade: true });
    await saveDispatcherSetupStatus('done');
    expect(getSettings().setup).toEqual({ status: 'done', upgrade: true });
  });
});

describe('Try it out', () => {
  const req = { name: 'Rosie', provider: 'codex-cli', behavior: 'standard' as const, personality: { preset: 'friendly' as const, text: PERSONALITY_PRESET_TEXT.friendly } };

  it('asks the chat\'s model one sample question with the name and personality, and shows the reply', async () => {
    const run = vi.fn(async () => ({ ok: true as const, text: 'Hi, I\'m Rosie!' }));
    const resolve = vi.fn(async () => MODELS);
    const result = await tryDispatcherPersonality(req, { run, resolve });
    expect(result).toEqual({ ok: true, text: 'Hi, I\'m Rosie!' });
    expect(resolve).toHaveBeenCalledWith('codex-cli', 'standard');
    expect(run).toHaveBeenCalledTimes(1);
    const [sent] = run.mock.calls[0] as unknown as [{ provider: string; model: string; effort: string | null; prompt: string; timeoutMs: number }];
    expect(sent).toMatchObject({ provider: 'codex-cli', model: 'sonnet', effort: 'medium', timeoutMs: TRY_IT_OUT_TIMEOUT_MS });
    expect(sent.prompt).toContain('You are Rosie');
    expect(sent.prompt).toContain(PERSONALITY_PRESET_TEXT.friendly);
    expect(sent.prompt).toContain(TRY_IT_OUT_QUESTION);
    expect(sent.prompt).not.toContain('\n');
  });

  it('contacts no agent: nothing is started, woken or messaged, and the real runner is never used', async () => {
    await tryDispatcherPersonality(req, { run: async () => ({ ok: true, text: 'ok' }), resolve: async () => MODELS });
    expect(agentSystem.spawnAgent).not.toHaveBeenCalled();
    expect(agentSystem.wakeAgent).not.toHaveBeenCalled();
    expect(channel.deliverToDispatcher).not.toHaveBeenCalled();
    expect(channel.wakeAndDeliver).not.toHaveBeenCalled();
    expect(runHeadlessPrompt).not.toHaveBeenCalled();
  });

  it('uses the provider\'s default model where Auto has none, as the Dispatcher would', async () => {
    const run = vi.fn(async () => ({ ok: true as const, text: 'ok' }));
    await tryDispatcherPersonality(req, { run, resolve: async () => ({ ok: false, code: 'auto_not_supported', message: 'none' }) });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ model: 'default', effort: null }));
    run.mockClear();
    await tryDispatcherPersonality(req, { run, resolve: async () => { throw new Error('cli broke'); } });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ model: 'default' }));
  });

  it('says why when there is no reply, and never throws', async () => {
    expect(await tryDispatcherPersonality(req, { run: async () => ({ ok: false, error: 'It took too long.' }), resolve: async () => MODELS }))
      .toEqual({ ok: false, error: 'Couldn’t get a reply. It took too long.' });
    expect(await tryDispatcherPersonality(req, { run: async () => { throw new Error('spawn failed'); }, resolve: async () => MODELS }))
      .toEqual({ ok: false, error: 'Couldn’t get a reply. spawn failed' });
  });
});

describe('checkDispatcherBehavior', () => {
  it('reports whether Auto gives the level its models on a provider not saved yet', async () => {
    const { resolveAutoLevel } = await import('../helper-routing');
    vi.mocked(resolveAutoLevel).mockResolvedValue({ ok: false, code: 'no_valid_mapping', message: 'nothing offered' });
    expect(await checkDispatcherBehavior('claude-code', 'thorough')).toEqual({ ready: false, code: 'no_valid_mapping' });
    vi.mocked(resolveAutoLevel).mockResolvedValueOnce({ ok: false, code: 'auto_not_supported', message: 'no presets' });
    expect(await checkDispatcherBehavior('future-cli', 'light')).toEqual({ ready: false, code: 'auto_not_supported' });
    vi.mocked(resolveAutoLevel).mockResolvedValue({ ok: true, provider: 'claude-code', level: 'medium', model: 'sonnet', effort: 'medium', source: 'builtin_mapping', fallback: 'none' } as never);
    expect(await checkDispatcherBehavior('claude-code', 'standard')).toEqual({ ready: true });
  });
});
