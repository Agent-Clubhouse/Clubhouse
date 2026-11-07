import { describe, expect, it } from 'vitest';
import { helperTemplateModel } from './helpers';

describe('helperTemplateModel (D52)', () => {
  it('uses the template model when start_helper leaves model out and the CLIs agree', () => {
    expect(helperTemplateModel({ model: 'haiku' }, {}, 'claude-code')).toBe('haiku');
    expect(helperTemplateModel({ orchestrator: 'codex-cli', model: 'gpt-5' }, { cli: 'codex-cli' }, 'claude-code')).toBe('gpt-5');
    expect(helperTemplateModel({ orchestrator: 'claude-code', model: 'opus' }, {}, 'claude-code')).toBe('opus');
  });

  it('leaves it out when the start names a model, the CLIs differ, or the template says default', () => {
    expect(helperTemplateModel({ model: 'haiku' }, { model: 'opus' }, 'claude-code')).toBeUndefined();
    expect(helperTemplateModel({ model: 'haiku' }, { cli: 'codex-cli' }, 'claude-code')).toBeUndefined();
    expect(helperTemplateModel({ orchestrator: 'codex-cli', model: 'gpt-5' }, {}, 'claude-code')).toBeUndefined();
    expect(helperTemplateModel({ orchestrator: 'codex-cli', model: 'gpt-5' }, { cli: 'claude-code' }, 'claude-code')).toBeUndefined();
    expect(helperTemplateModel({ model: 'default' }, {}, 'claude-code')).toBeUndefined();
    expect(helperTemplateModel({}, {}, 'claude-code')).toBeUndefined();
  });
});
