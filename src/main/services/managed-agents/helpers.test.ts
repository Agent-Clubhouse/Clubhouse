import { describe, expect, it, vi } from 'vitest';
import { helperTemplateModel } from './helpers';

const fits = (accepted: Record<string, string[]>) => vi.fn(async (cli: string, model: string) => (accepted[cli] ?? []).includes(model));

describe('helperTemplateModel (D52)', () => {
  it('uses the template model when start_helper leaves model out and the CLIs agree', async () => {
    expect(await helperTemplateModel({ model: 'haiku' }, {}, 'claude-code', fits({ 'claude-code': ['haiku'] }))).toBe('haiku');
    expect(await helperTemplateModel({ orchestrator: 'codex-cli', model: 'gpt-5' }, {}, 'codex-cli', fits({}))).toBe('gpt-5');
    expect(await helperTemplateModel({ orchestrator: 'claude-code', model: 'opus' }, {}, 'claude-code', fits({}))).toBe('opus');
  });

  it('leaves it out when the start names a model, the CLIs differ, the CLI is not known yet, or the template says default', async () => {
    const any = fits({ 'claude-code': ['haiku'], 'codex-cli': ['gpt-5'] });
    expect(await helperTemplateModel({ model: 'haiku' }, { model: 'opus' }, 'claude-code', any)).toBeUndefined();
    expect(await helperTemplateModel({ orchestrator: 'codex-cli', model: 'gpt-5' }, {}, 'claude-code', any)).toBeUndefined();
    expect(await helperTemplateModel({ model: 'haiku' }, {}, undefined, any)).toBeUndefined();
    expect(await helperTemplateModel({ model: 'default' }, {}, 'claude-code', any)).toBeUndefined();
    expect(await helperTemplateModel({}, {}, 'claude-code', any)).toBeUndefined();
  });

  it('leaves it out when the start names a difficulty, so the preset picks the model', async () => {
    const check = fits({ 'claude-code': ['haiku'] });
    expect(await helperTemplateModel({ model: 'haiku' }, { difficulty: 'hard' }, 'claude-code', check)).toBeUndefined();
    expect(await helperTemplateModel({ orchestrator: 'claude-code', model: 'haiku' }, { difficulty: 'easy' }, 'claude-code', check)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('gives a template with no CLI its model only when the CLI the helper runs on takes it', async () => {
    const check = fits({ 'claude-code': ['haiku'], 'codex-cli': ['gpt-5'] });
    expect(await helperTemplateModel({ model: 'gpt-5' }, {}, 'codex-cli', check)).toBe('gpt-5');
    expect(check).toHaveBeenLastCalledWith('codex-cli', 'gpt-5');
    expect(await helperTemplateModel({ model: 'gpt-5' }, {}, 'claude-code', check)).toBeUndefined();
    expect(await helperTemplateModel({ model: 'haiku' }, {}, 'codex-cli', check)).toBeUndefined();
  });
});
