import { describe, expect, it } from 'vitest';
import { resolveEffectiveFeature, SESSION_FEATURE_FIELDS, type SessionFeature } from '../../../shared/providers/features';
import { acpChatCapabilities, negotiate, type AcpSessionFacts } from './capabilities';
import type { SessionConfigOption } from './protocol';

// How the ACP capability record reads through the provider feature resolver
// (#3787). No ACP provider has a descriptor yet, so declarations are undefined
// and every session feature is decided by the negotiated session alone.

const MODEL: SessionConfigOption = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] };
const EFFORT: SessionConfigOption = { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] };

function features(facts: Partial<AcpSessionFacts>, init = {}, questionsClaim = false): Record<SessionFeature, string> {
  const session = acpChatCapabilities(
    negotiate({ protocolVersion: 1, ...init }, true),
    { configOptions: [], commands: false, usage: false, ...facts },
    { questions: questionsClaim },
  );
  const out = {} as Record<SessionFeature, string>;
  for (const feature of Object.keys(SESSION_FEATURE_FIELDS) as SessionFeature[]) {
    const effective = resolveEffectiveFeature({ declarations: undefined, runtime: 'chat', feature, session });
    expect(effective.source).toBe('session');
    out[feature] = effective.support;
  }
  return out;
}

describe('ACP capabilities through the provider feature resolver', () => {
  it('a bare agent: only cancellation, which ACP makes mandatory', () => {
    expect(features({})).toEqual({
      steering: 'unsupported', cancellation: 'supported', images: 'unsupported', questions: 'unsupported',
      session_resume: 'unsupported', usage: 'unsupported', model_switch: 'unsupported', effort_switch: 'unsupported',
    });
  });

  it('turns features on only from negotiated or observed facts', () => {
    expect(features(
      { configOptions: [MODEL, EFFORT], usage: true },
      { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } },
      true,
    )).toEqual({
      steering: 'unsupported', cancellation: 'supported', images: 'supported', questions: 'supported',
      session_resume: 'supported', usage: 'supported', model_switch: 'supported', effort_switch: 'supported',
    });
  });

  it('effort without a model option reads as supported: the caller-contract gate before registration', () => {
    // setModel refuses any model id here, and current callers always pass one,
    // so this "supported" can't be reached yet (see README, Before registration).
    expect(features({ configOptions: [EFFORT] })).toMatchObject({ model_switch: 'unsupported', effort_switch: 'supported' });
  });
});
