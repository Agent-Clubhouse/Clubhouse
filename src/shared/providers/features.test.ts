import { describe, expect, it } from 'vitest';
import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities } from '../chat/capabilities';
import { resolveEffectiveFeature, type ProviderFeatureDeclarations } from './features';

const caps = (over: Partial<ChatCapabilities>): ChatCapabilities => ({ ...MINIMAL_CHAT_CAPABILITIES, ...over });

describe('resolveEffectiveFeature', () => {
  it('an undeclared feature, or an unknown provider, is unknown rather than unsupported', () => {
    expect(resolveEffectiveFeature({ declarations: undefined, feature: 'mcp' })).toEqual({ feature: 'mcp', support: 'unknown', source: 'undeclared' });
    expect(resolveEffectiveFeature({ declarations: { chat: {} }, runtime: 'chat', feature: 'skills' }).support).toBe('unknown');
  });

  it('a runtime entry wins over common, and common applies when the runtime is unknown', () => {
    const decl: ProviderFeatureDeclarations = {
      common: { session_history: { support: 'supported' } },
      terminal: { session_history: { support: 'unsupported', reason: 'no reader' } },
    };
    expect(resolveEffectiveFeature({ declarations: decl, feature: 'session_history' }).support).toBe('supported');
    expect(resolveEffectiveFeature({ declarations: decl, runtime: 'chat', feature: 'session_history' }).support).toBe('supported');
    expect(resolveEffectiveFeature({ declarations: decl, runtime: 'terminal', feature: 'session_history' })).toMatchObject({ support: 'unsupported', reason: 'no reader', source: 'declared' });
  });

  it('a declared default does not freeze what the session negotiates, either way', () => {
    const decl: ProviderFeatureDeclarations = { chat: { questions: { support: 'unsupported', reason: 'not surfaced' }, steering: { support: 'supported' } } };
    expect(resolveEffectiveFeature({ declarations: decl, runtime: 'chat', feature: 'questions', session: caps({ questions: true }) }))
      .toMatchObject({ support: 'supported', source: 'session' });
    expect(resolveEffectiveFeature({ declarations: decl, runtime: 'chat', feature: 'steering', session: caps({ steer: false }) }))
      .toMatchObject({ support: 'unsupported', source: 'session' });
  });

  it('only explicit policy overrides the session', () => {
    const decl: ProviderFeatureDeclarations = { chat: { images: { support: 'unsupported', policy: 'forbidden', reason: 'Clubhouse decision' } } };
    expect(resolveEffectiveFeature({ declarations: decl, runtime: 'chat', feature: 'images', session: caps({ images: true }) }))
      .toEqual({ feature: 'images', support: 'unsupported', source: 'policy', reason: 'Clubhouse decision' });
  });

  it('the session never decides features without a direct capability field', () => {
    const full = caps({ steer: true, interrupt: true, images: true, questions: true, resume: 'native', usage: 'cost', modelSwitch: 'live', effortSwitch: 'live', slashCommands: true, systemPrompt: true });
    for (const feature of ['tools', 'mcp', 'managed_instructions', 'skills', 'permissions', 'session_history'] as const) {
      expect(resolveEffectiveFeature({ declarations: {}, runtime: 'chat', feature, session: full })).toMatchObject({ support: 'unknown', source: 'undeclared' });
    }
  });

  it('conditions need evidence: met, unmet, or left unresolved', () => {
    const decl: ProviderFeatureDeclarations = { terminal: { mcp: { support: 'conditional', conditions: [
      { kind: 'platform', id: 'platform:darwin', description: 'macOS only' },
      { kind: 'version', id: 'version:>=1.2.0', description: 'Needs 1.2.0 or later' },
    ] } } };
    const r = (evidence?: Record<string, boolean | undefined>) => resolveEffectiveFeature({ declarations: decl, runtime: 'terminal', feature: 'mcp', evidence });
    expect(r()).toMatchObject({ support: 'conditional', unresolved: ['platform:darwin', 'version:>=1.2.0'] });
    expect(r({ 'platform:darwin': true })).toMatchObject({ support: 'conditional', unresolved: ['version:>=1.2.0'] });
    expect(r({ 'platform:darwin': true, 'version:>=1.2.0': false })).toMatchObject({ support: 'unsupported', reason: 'Needs 1.2.0 or later', source: 'conditions' });
    expect(r({ 'platform:darwin': true, 'version:>=1.2.0': true })).toMatchObject({ support: 'supported', source: 'conditions' });
  });
});
