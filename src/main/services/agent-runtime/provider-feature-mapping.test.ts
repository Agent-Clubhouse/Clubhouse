import { describe, expect, it } from 'vitest';
import { PERMISSION_LEVELS, type ChatCapabilities } from '../../../shared/chat/capabilities';
import { PROVIDER_DESCRIPTORS, type BuiltinProviderId } from '../../../shared/providers/descriptors';
import { SESSION_FEATURE_FIELDS, resolveEffectiveFeature, type SessionFeature } from '../../../shared/providers/features';
import { claudeCapabilities } from '../../chat/claude/driver';
import { COPILOT_SDK_CAPABILITIES } from '../../chat/copilot/driver';
import { CODEX_CHAT_CAPABILITIES } from '../../orchestrators/adapters/codex-chat-driver';

/**
 * The existing-provider mapping (#3787): each descriptor's static chat
 * declarations must match what the provider's real driver publishes in
 * `session_started`. The capabilities come from the drivers' own exports, so
 * the table can't claim a feature the adapter doesn't negotiate, or hide one it
 * does. Claude's record varies only in `liveLevels` by start level, so every
 * level is checked.
 */
const PUBLISHED: Record<BuiltinProviderId, readonly ChatCapabilities[]> = {
  'claude-code': PERMISSION_LEVELS.map((level) => claudeCapabilities(level)),
  'codex-cli': [CODEX_CHAT_CAPABILITIES],
  'copilot-cli': [COPILOT_SDK_CAPABILITIES],
};

const SESSION_FEATURES = Object.keys(SESSION_FEATURE_FIELDS) as SessionFeature[];

describe('descriptor chat features match the drivers', () => {
  for (const [provider, records] of Object.entries(PUBLISHED) as [BuiltinProviderId, readonly ChatCapabilities[]][]) {
    it(`${provider}`, () => {
      const declarations = PROVIDER_DESCRIPTORS[provider].features;
      for (const session of records) {
        for (const feature of SESSION_FEATURES) {
          const declared = resolveEffectiveFeature({ declarations, runtime: 'chat', feature });
          const negotiated = resolveEffectiveFeature({ declarations, runtime: 'chat', feature, session });
          expect({ feature, support: declared.support }).toEqual({ feature, support: negotiated.support });
        }
      }
    });
  }

  it('a negotiated session decides exactly as the capability field did before', () => {
    for (const records of Object.values(PUBLISHED)) {
      for (const session of records) {
        expect(resolveEffectiveFeature({ declarations: undefined, runtime: 'chat', feature: 'images', session }).support === 'supported').toBe(session.images === true);
        expect(resolveEffectiveFeature({ declarations: undefined, runtime: 'chat', feature: 'steering', session }).support === 'supported').toBe(session.steer);
        expect(resolveEffectiveFeature({ declarations: undefined, runtime: 'chat', feature: 'cancellation', session }).support === 'supported').toBe(session.interrupt);
      }
    }
  });
});
