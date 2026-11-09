import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPATCHER_MODELS_STATE,
  DISPATCHER_ROLE_LABELS,
  cleanModelsUpdate,
  mergeRoleModel,
  normalizeDispatcherModels,
  normalizeRoleModel,
  type DispatcherRoleModel,
} from './dispatcher-models';

const pick: DispatcherRoleModel = { provider: 'claude-code', model: 'opus', effort: 'high', contextWindow: '1000000' };

describe('Choose models yourself (#3191)', () => {
  it('reads missing or broken saved values as off, and keeps what is valid', () => {
    expect(normalizeDispatcherModels(undefined)).toEqual(DEFAULT_DISPATCHER_MODELS_STATE);
    expect(normalizeDispatcherModels('on')).toEqual(DEFAULT_DISPATCHER_MODELS_STATE);
    expect(normalizeDispatcherModels({ byHand: 'yes', chat: pick })).toEqual({ byHand: false, chat: pick, work: null });
    expect(normalizeDispatcherModels({ byHand: true, chat: pick, work: { provider: 'codex-cli' } })).toEqual({
      byHand: true, chat: pick, work: { provider: 'codex-cli', model: 'default', effort: null, contextWindow: null },
    });
  });

  it('drops a pick with no provider, and an effort that could reach a CLI\'s arguments', () => {
    expect(normalizeRoleModel({ model: 'opus' })).toBeNull();
    expect(normalizeRoleModel({ ...pick, effort: 'high; rm -rf /' })).toEqual({ ...pick, effort: null });
  });

  it('takes the switch or one job\'s fields, nothing else', () => {
    expect(cleanModelsUpdate({ byHand: true })).toEqual({ byHand: true });
    expect(cleanModelsUpdate({ role: 'work', provider: 'codex-cli' })).toEqual({ role: 'work', provider: 'codex-cli' });
    expect(cleanModelsUpdate({ role: 'chat', effort: null, contextWindow: null })).toEqual({ role: 'chat', effort: null, contextWindow: null });
    for (const bad of [null, 'chat', {}, { byHand: 'on' }, { byHand: true, role: 'chat' }, { role: 'both', model: 'opus' }, { role: 'chat' },
      { role: 'chat', effort: 'HIGH!' }, { role: 'chat', model: '' }, { role: 'chat', provider: 'x'.repeat(201) }]) {
      expect(() => cleanModelsUpdate(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('goes back to the default model, effort and context with a new provider', () => {
    expect(mergeRoleModel(pick, { provider: 'codex-cli' })).toEqual({ provider: 'codex-cli', model: 'default', effort: null, contextWindow: null });
    expect(mergeRoleModel(pick, { provider: 'codex-cli', model: 'sol', effort: 'high' })).toEqual({ provider: 'codex-cli', model: 'sol', effort: 'high', contextWindow: null });
  });

  it('clears the effort and context with a new model, and keeps them otherwise', () => {
    expect(mergeRoleModel(pick, { model: 'sonnet' })).toEqual({ ...pick, model: 'sonnet', effort: null, contextWindow: null });
    expect(mergeRoleModel(pick, { model: 'opus', effort: 'low' })).toEqual({ ...pick, effort: 'low' });
    expect(mergeRoleModel(pick, { contextWindow: null })).toEqual({ ...pick, contextWindow: null });
  });

  it('names the jobs by what they do for the user', () => {
    expect(DISPATCHER_ROLE_LABELS.chat.label).toBe('Talking with you');
    expect(DISPATCHER_ROLE_LABELS.work.label).toBe('Working in the background');
  });
});
