import type { AdaptiveEvidence } from '../helper-adaptive-evaluation';
/** Recorded-shape SYNTHETIC observations, declared before model fitting. No real account or provider activity. */
export const ADAPTIVE_FIXTURE_START = 1_800_000_000_000;
export function adaptiveEvidenceFixture(scenario: 'stationary' | 'linear' | 'outside' | 'reset' | 'upgrade' | 'sparse' = 'stationary'): AdaptiveEvidence[] {
  return Array.from({ length: 400 }, (_, i) => {
    const provider = i % 2 ? 'codex-cli' as const : 'claude-code' as const;
    const elapsedMinutes = scenario === 'linear' ? Math.floor(i / 2) % 21 : [0, 1, 3, 8, 20][Math.floor(i / 2) % 5];
    const atMs = ADAPTIVE_FIXTURE_START + i * 60_000;
    const elapsedIndex = Math.floor(i / 2) % 5;
    const remaining = scenario === 'linear' ? 600 - 20 * elapsedMinutes : [600, 580, 500, 340, 100][elapsedIndex];
    return {
      schemaVersion: 1, id: `synthetic-${i}`, atMs, availableAtMs: atMs + 30_000, provider,
      model: scenario === 'sparse' ? `synthetic-${i % 200}` : 'synthetic-model-v1', effort: 'high',
      mappingGeneration: 'mapping-v1', planGeneration: scenario === 'upgrade' && i >= 240 ? 'synthetic-plan-upgraded' : 'synthetic-plan-v1',
      resetEpoch: ADAPTIVE_FIXTURE_START + (scenario === 'reset' && i >= 240 ? 8 : 7) * 86_400_000,
      difficulty: 'hard', profile: 'unspecified', elapsedMs: elapsedMinutes * 60_000,
      usageTokens: i * 100, remainingBp: remaining + (provider === 'codex-cli' ? 100 : 0) + (scenario === 'outside' && i >= 320 ? 1000 : 0),
      endUsedBp: i % 101 === 0 ? 10000 : 1000 + i * 10,
      outcome: i % 29 === 28 ? 'cancelled' : i % 17 === 16 ? 'failed' : 'completed', source: 'synthetic',
    };
  });
}
