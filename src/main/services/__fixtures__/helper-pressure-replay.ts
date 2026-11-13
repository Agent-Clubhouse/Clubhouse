/** Synthetic, content-free subscription simulator. No provider process, paid prompt or token conversion. */
import { decideAutoProvider, type AutoCandidate } from '../helper-auto-policy';
import { preparePressure, observePressure, type PressureEntry } from '../helper-burn-pressure';
import type { DecisionQuota } from '../../../shared/telemetry/helper-usage-contract';
import type { QuotaView } from '../../../shared/helper-routing';
const MIN = 60_000, T = 1_800_000_000_000;
export interface PressureReplayReport {
  simulated: true;
  accepted: number;
  refused: number;
  failures: number;
  cancellations: number;
  depletion: number;
  maxAdmissionGap: number;
  meanSpreadBp: number;
  qualifiedDecisions: number;
  byProvider: Record<string, { evaluated: number; maeBp: number | null; biasBp: number | null; coverageBp: number | null; excluded: number }>;
}
export function replayPressureScenario(forecasts: boolean, scenario: 'equal' | 'unequal' | 'staggered' | 'outside' | 'upgrade' | 'long'): PressureReplayReport {
  const history: PressureEntry[] = [];
  const running: Array<{ e: PressureEntry; until: number; total: number; burned: number }> = [];
  const ids = ['claude-code', 'codex-cli'];
  const used: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const cursors: Record<string, string> = {}, lastAdmitted: Record<string, number> = {};
  const reset: Record<string, number> = { 'claude-code': T + (scenario === 'staggered' ? 600 : 10080) * MIN, 'codex-cli': T + 10080 * MIN };
  const report: PressureReplayReport = { simulated: true, accepted: 0, refused: 0, failures: 0, cancellations: 0, depletion: 0,
    maxAdmissionGap: 0, meanSpreadBp: 0, qualifiedDecisions: 0, byProvider: {} };
  const planAt = (now: number) => ({ plan: scenario === 'upgrade' && now >= T + 600 * MIN ? 'plus' as const : 'pro' as const, generation: scenario === 'upgrade' && now >= T + 600 * MIN ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111' });
  const quota = (provider: string, now: number): DecisionQuota => ({ state: used[provider] >= 10000 ? 'exhausted' : used[provider] >= 9500 ? 'near_limit' : used[provider] >= 8000 ? 'low' : 'known',
    source: 'cli_query', quality: 'fresh', asOfMs: now, windows: [{ name: 'weekly', usedBp: Math.round(used[provider]), resetsAtMs: reset[provider] }] });
  for (let minute = 0; minute <= 1250; minute++) {
    const now = T + minute * MIN;
    for (const r of running) {
      const addition = r.total * Math.min(1, MIN / (r.until - r.e.decidedAtMs));
      const delta = Math.min(addition, r.total - r.burned);
      used[r.e.provider!] += delta; r.burned += delta;
      if (now >= r.until) r.e.forecastRun!.endedMs = r.until;
    }
    for (let i = running.length - 1; i >= 0; i--) if (now >= running[i].until) running.splice(i, 1);
    if (scenario === 'outside' && minute === 650) used['claude-code'] += 3000;
    for (const id of ids) {
      if (now >= reset[id]) { used[id] = 0; reset[id] += 10080 * MIN; }
      const q = quota(id, now);
      const view: QuotaView = { state: q.state, source: 'cli_query', asOf: new Date(now).toISOString(),
        weekly: { usedPercent: used[id] / 100, resetsAt: new Date(reset[id]).toISOString() } };
      for (const e of history) if (e.provider === id && e.pressure && !e.pressureOutcome) {
        const observation = observePressure(e.pressure, history, view, now, planAt(now));
        if (observation) e.pressureOutcome = observation;
      }
    }
    if (minute % 5 === 0 && minute < 1250) {
      for (let n = 0; n < 3; n++) {
        const decisionId = `sim-${minute}-${n}`;
        const proposed = new Map<string, PressureEntry>();
        const candidates: AutoCandidate[] = ids.map((provider) => {
          const e: PressureEntry = { decisionId, decidedAtMs: now, provider, model: 'recorded-model', effort: 'high', difficulty: 'hard', taskProfile: 'implementation',
            calibration: { model: 'recorded-model', revision: '11111111-1111-4111-8111-111111111111' } };
          const load = running.filter((r) => r.e.provider === provider).length;
          const q = quota(provider, now);
          e.pressure = preparePressure(e, history, load, q, now, planAt(now));
          proposed.set(provider, e);
          const band = e.pressure?.windows[0].band;
          return { key: provider, provider, quotaState: q.state, verified: true, load,
            weekly: { usedPercent: used[provider] / 100, resetsAtMs: reset[provider] },
            ...(forecasts && band && { expectedBurnBp: band.meanBp, remainingPressure: [{ usedBp: Math.round(used[provider]), upperBp: band.upperBp }] }) };
        });
        const decision = decideAutoProvider({ now, candidates, cursors, options: { useBurnForecasts: forecasts } });
        if (!decision.ok) { report.refused++; continue; }
        if (decision.tie.cursorKey && decision.tie.cursorAfter) cursors[decision.tie.cursorKey] = decision.tie.cursorAfter;
        const e = proposed.get(decision.provider)!;
        if (forecasts && e.pressure?.windows[0].band) report.qualifiedDecisions++;
        report.accepted++;
        const failure = (minute / 5 * 3 + n) % 17 === 16, cancelled = (minute / 5 * 3 + n) % 29 === 28;
        if (failure) report.failures++;
        if (cancelled) report.cancellations++;
        e.forecastRun = { startedMs: now, usageSamples: 1, usable: !failure && !cancelled };
        history.push(e);
        const unequal = scenario !== 'equal';
        const total = (decision.provider === 'codex-cli' && unequal ? 7 : 20) * (failure || cancelled ? 0.5 : 1);
        running.push({ e, until: now + (failure || cancelled ? MIN : scenario === 'long' ? 60 * MIN : 3 * MIN), total, burned: 0 });
        if (lastAdmitted[decision.provider] !== undefined) report.maxAdmissionGap = Math.max(report.maxAdmissionGap, minute - lastAdmitted[decision.provider]);
        lastAdmitted[decision.provider] = minute;
      }
    }
    report.meanSpreadBp += Math.abs(used[ids[0]] - used[ids[1]]) / 1251;
  }
  report.depletion = ids.filter((id) => used[id] >= 10000).length;
  for (const provider of ids) {
    const observed = history.filter((e) => e.provider === provider && e.pressure?.windows[0].band && e.pressureOutcome?.reason === 'observed');
    const errors = observed.map((e) => e.pressureOutcome!.windows[0].remainingBp - e.pressure!.windows[0].band!.meanBp);
    const covered = observed.filter((e) => { const band = e.pressure!.windows[0].band!; const y = e.pressureOutcome!.windows[0].remainingBp; return y >= band.lowerBp && y <= band.upperBp; });
    report.byProvider[provider] = { evaluated: errors.length, maeBp: errors.length ? errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length : null,
      biasBp: errors.length ? errors.reduce((s, e) => s + e, 0) / errors.length : null,
      coverageBp: errors.length ? 10000 * covered.length / errors.length : null,
      excluded: history.filter((e) => e.provider === provider && e.pressureOutcome && e.pressureOutcome.reason !== 'observed').length };
  }
  return report;
}
