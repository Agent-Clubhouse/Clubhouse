import { describe, expect, it } from 'vitest';
import { replayPressureScenario } from './__fixtures__/helper-pressure-replay';

describe('stage 3 chronological simulated routing outcomes', () => {
  for (const scenario of ['equal', 'unequal', 'staggered', 'outside', 'upgrade', 'long'] as const) {
    it(`compares stage 1 and qualified stage 3 on ${scenario} budgets/activity`, () => {
      const stage1 = replayPressureScenario(false, scenario), stage3 = replayPressureScenario(true, scenario);
      if (scenario === 'long') expect(stage3.qualifiedDecisions).toBe(0);
      else expect(stage3.qualifiedDecisions).toBeGreaterThan(0);
      expect(stage3.depletion).toBeLessThanOrEqual(stage1.depletion);
      expect(stage3.refused).toBeLessThanOrEqual(stage1.refused);
      expect(stage3.failures).toBe(stage1.failures);
      expect(stage3.cancellations).toBe(stage1.cancellations);
      expect(stage3.maxAdmissionGap).toBeLessThanOrEqual(stage1.maxAdmissionGap + 5);
      expect(stage3.meanSpreadBp).toBeLessThanOrEqual(stage1.meanSpreadBp + 100);
    });
  }
});
