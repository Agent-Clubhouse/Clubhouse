/**
 * Helper decision, outcome and usage telemetry (#2747, epic #2886).
 *
 * Routing calls the `record*` functions at its decision points. This module
 * turns what it is given into local, bounded, hashed events, keeps the
 * helper-to-decision join (helper-decision-ledger.ts), and watches the chat
 * event bus to measure what each helper run actually used. See
 * docs/helper-auto-routing.md "Telemetry" for the events and how to read them.
 *
 * Safety:
 * - Every event is written with `localOnly`: it reaches the local recording at
 *   the configured level and no export destination, whatever its preset.
 * - Ids are hashed by the facade. A model id is a salted hash plus a closed
 *   family. No prompt, task text, path, account detail or credential is read.
 * - Nothing here changes routing, spawns, probes a provider or spends tokens.
 *   Every function returns void and swallows its own errors.
 * - When telemetry is off nothing is recorded and nothing is written; helpers
 *   started then have no ledger entry, and their joins say `decision_known=false`.
 * - Event volume is capped per hour (HELPER_TELEMETRY_LIMITS), so a burst of
 *   starts cannot crowd out other signals.
 */
import { randomUUID } from 'crypto';
import { ATTR, levelAllows, type EventName, type TelAttr } from '../../shared/telemetry/attributes';
import type { ChatEvent, ChatEventDataMap } from '../../shared/chat/events';
import type { QuotaView, QuotaWindowView } from '../../shared/helper-routing';
import {
  HELPER_TELEMETRY_LIMITS,
  HELPER_TELEMETRY_SCHEMA_VERSION,
  type DecisionCandidate,
  type HelperDecisionRecord,
  type HelperReuseRecord,
  type HelperRunOutcome,
  type HelperSpawnResultRecord,
} from '../../shared/telemetry/helper-usage-contract';
import { onChatEvent } from '../services/agent-runtime/chat-event-bus';
import { onAgentExit } from '../services/agent-exit-broadcast';
import { isTelemetryActive, tel, telemetryLevel } from './facade';
import { modelFamily, orchestratorAttr } from './spawn-telemetry';
import * as ledger from './helper-decision-ledger';
import { RunUsageTracker, type UsageSample } from './helper-usage-accounting';
import { observeHelperBurn, predictHelperBurn, readBurnCalibrationIdentity, summarizeHelperBurn, type BurnCalibration, type BurnForecast } from '../services/helper-auto-forecast';

// --- Gate and budget -------------------------------------------------------------

const HOUR_MS = 60 * 60_000;
let budgetWindowStart = 0;
let budgetUsed = 0;
let budgetDropped = 0;
let clock: () => number = Date.now;

/** Local recording is on, at a level that records standard events. */
function recordingOn(): boolean {
  if (!isTelemetryActive()) return false;
  const level = telemetryLevel();
  return !!level && levelAllows(level, 'standard');
}

/** Recording is on and the hourly budget has room. */
function admit(): boolean {
  if (!recordingOn()) return false;
  const t = clock();
  if (t - budgetWindowStart >= HOUR_MS) {
    budgetWindowStart = t;
    budgetUsed = 0;
  }
  if (budgetUsed >= HELPER_TELEMETRY_LIMITS.maxEventsPerHour) {
    budgetDropped++;
    return false;
  }
  budgetUsed++;
  return true;
}

function emit(name: EventName, attrs: Array<TelAttr | undefined | false>): void {
  tel.event(name, attrs.filter((a): a is TelAttr => !!a), { localOnly: true });
}

/** Run a recorder body: never throws, nothing recorded while telemetry is off. */
function guarded(body: () => void): void {
  try {
    if (!recordingOn()) return;
    body();
  } catch {
    // Telemetry never affects routing or a run.
  }
}

// --- Small encoders ---------------------------------------------------------------

type Cli = Parameters<typeof ATTR.orchestrator>[0];

function cli(provider: string | null | undefined): Cli {
  return orchestratorAttr(provider ?? undefined);
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
function effortAttr(effort: string | null | undefined): TelAttr {
  return ATTR.helperRoutingEffort(!effort ? 'none' : EFFORTS.has(effort) ? effort as 'low' : 'other');
}

/** 0..100 percent to integer basis points. NaN, infinity and negatives are unavailable, not 0. */
function bp(percent: number | null | undefined): number | undefined {
  return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 ? Math.round(percent * 100) : undefined;
}

const ms = (t: number | null | undefined): number | undefined => (typeof t === 'number' && Number.isFinite(t) && t >= 0 ? Math.trunc(t) : undefined);
const iso = (t: string | null | undefined): number | undefined => {
  const parsed = t ? Date.parse(t) : NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};
const count = (n: number | undefined): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined);

// --- Decisions --------------------------------------------------------------------

/** A fresh decision id, for routing to stamp on a decision, its reservation and its record. */
export function newDecisionId(): string {
  return randomUUID();
}

function quotaAttrs(q: NonNullable<DecisionCandidate['quota']>): Array<TelAttr | undefined> {
  const weekly = q.windows?.find((w) => w.name === 'weekly');
  const five = q.windows?.find((w) => w.name === 'fiveHour');
  const limiting = q.windows?.find((w) => w.limitReached);
  return [
    ATTR.helperQuotaState(q.state),
    ATTR.helperQuotaSource(q.source),
    ATTR.helperQuotaUnknownReason(q.unknownReason ?? 'none'),
    q.quality ? ATTR.helperQuotaQuality(q.quality) : undefined,
    ms(q.asOfMs) !== undefined ? ATTR.helperQuotaAsOfMs(ms(q.asOfMs)!) : undefined,
    weekly?.usedBp !== undefined ? ATTR.helperQuotaWeeklyUsedBp(weekly.usedBp) : undefined,
    ms(weekly?.resetsAtMs) !== undefined ? ATTR.helperQuotaWeeklyResetsMs(ms(weekly?.resetsAtMs)!) : undefined,
    five?.usedBp !== undefined ? ATTR.helperQuotaFiveHourUsedBp(five.usedBp) : undefined,
    ms(five?.resetsAtMs) !== undefined ? ATTR.helperQuotaFiveHourResetsMs(ms(five?.resetsAtMs)!) : undefined,
    ATTR.helperQuotaOtherWindows((q.windows ?? []).filter((w) => w.name === 'other' || w.name === 'model').length),
    q.windows?.some((w) => w.limitReached) ? ATTR.helperQuotaLimitReached(true) : undefined,
    limiting ? ATTR.helperQuotaLimitingWindow(limiting.name) : undefined,
  ];
}

function candidateAttrs(decisionId: string, c: DecisionCandidate): Array<TelAttr | undefined | false> {
  return [
    ATTR.helperDecisionIdHash(decisionId),
    ATTR.orchestrator(cli(c.provider)),
    ATTR.helperCandidateEligible(c.eligible),
    ATTR.helperCandidateExcluded(c.excluded ?? 'none'),
    c.chosen !== undefined && ATTR.helperCandidateChosen(c.chosen),
    ATTR.helperCandidateLoadLive(count(c.load.live) ?? 0),
    ATTR.helperCandidateLoadReserved(count(c.load.reserved) ?? 0),
    c.mapped && ATTR.modelFamily(modelFamily(c.mapped.model ?? undefined)),
    c.mapped?.model ? ATTR.helperModelHash(c.mapped.model) : undefined,
    c.mapped && effortAttr(c.mapped.effort),
    c.mapped && ATTR.helperCandidateMappedSource(c.mapped.source),
    c.mapped && ATTR.helperCandidateMappedVerified(c.mapped.verified),
    c.accountKnown !== undefined && ATTR.helperCandidateAccountKnown(c.accountKnown),
    count(c.tier) !== undefined && ATTR.helperCandidateTier(count(c.tier)!),
    count(c.score?.rank) !== undefined && ATTR.helperCandidateRank(count(c.score?.rank)!),
    c.score && ATTR.helperScoreBasis(c.score.basis),
    c.score?.weeklyUsedBp !== undefined && ATTR.helperScoreWeeklyUsedBp(c.score.weeklyUsedBp),
    c.score?.cyclePhaseBp !== undefined && ATTR.helperScoreCyclePhaseBp(c.score.cyclePhaseBp),
    c.score?.targetBp !== undefined && ATTR.helperScoreTargetBp(c.score.targetBp),
    c.score?.pressureBp !== undefined && ATTR.helperScorePressureBp(c.score.pressureBp),
    ...(c.quota ? quotaAttrs(c.quota) : []),
  ];
}

type PendingDecision = Omit<ledger.LedgerEntry, 'helperId' | 'touchedMs' | 'spawn'>;

/** Chosen decisions whose helper id is not known yet, until it is bound. Bounded; the oldest goes first. */
const pendingDecisions = new Map<string, PendingDecision>();
const MAX_PENDING_DECISIONS = 64;

function bind(decisionId: string, helperId: string): void {
  const pending = pendingDecisions.get(decisionId);
  if (!pending) return;
  pendingDecisions.delete(decisionId);
  ledger.putDecision({ ...pending, helperId });
}

/**
 * The helper id of a chosen decision now exists. Call it as soon as the helper
 * is created and before it launches, so its first session is joined.
 */
export function bindHelperDecision(decisionId: string, helperId: string): void {
  guarded(() => bind(decisionId, helperId));
}

/** One routing decision, accepted or refused: the receipt, then one event per provider it considered. */
export function recordHelperDecision(rec: HelperDecisionRecord): void {
  guarded(() => {
    let forecast: BurnForecast | undefined;
    const calibration = readBurnCalibrationIdentity(rec.calibration);
    if (rec.outcome === 'chosen') {
      const decision: PendingDecision = {
        decisionId: rec.decisionId,
        decidedAtMs: rec.decidedAtMs,
        mode: rec.mode,
        policyVersion: rec.policyVersion,
        provider: rec.resolved.provider,
        model: rec.resolved.model,
        effort: rec.resolved.effort,
        difficulty: rec.resolved.difficulty,
        mappingRevision: rec.mappingRevision,
        ...(calibration && { calibration }),
        mappingFingerprint: rec.mappingFingerprint,
        ...(rec.taskProfile && { taskProfile: rec.taskProfile }),
      };
      if (rec.mode === 'auto') {
        const baseline = rec.candidates.find((c) => c.provider === rec.resolved.provider && c.chosen)?.quota;
        forecast = predictHelperBurn(decision, ledger.forecastHistory(), rec.decidedAtMs, baseline);
        decision.forecast = forecast;
      }
      pendingDecisions.set(rec.decisionId, decision);
      while (pendingDecisions.size > MAX_PENDING_DECISIONS) pendingDecisions.delete(pendingDecisions.keys().next().value as string);
      if (rec.helperId) bind(rec.decisionId, rec.helperId);
    }
    const refused = rec.outcome === 'refused';
    if (!admit()) return;
    const t = rec.thresholds;
    const tie = rec.tie;
    const candidates = rec.candidates.slice(0, HELPER_TELEMETRY_LIMITS.maxCandidatesPerDecision);
    emit('clubhouse.helper.decision', [
      ATTR.helperSchemaVersion(HELPER_TELEMETRY_SCHEMA_VERSION),
      ATTR.helperDecisionIdHash(rec.decisionId),
      rec.helperId ? ATTR.agentIdHash(rec.helperId) : undefined,
      ATTR.helperDecisionOutcome(rec.outcome),
      ATTR.helperAskerCli(rec.orchestratorProvider ? cli(rec.orchestratorProvider) : 'none'),
      refused && rec.refusalCode ? ATTR.helperAutoRefusal(rec.refusalCode) : undefined,
      ATTR.helperRoutingMode(rec.mode),
      ATTR.helperRoutingPolicyVersion(rec.policyVersion),
      ATTR.helperDecidedAtMs(ms(rec.decidedAtMs) ?? 0),
      ATTR.helperRoutingRequestedCli(rec.requested.provider === 'auto' ? 'auto' : rec.requested.provider ? cli(rec.requested.provider) : 'unset'),
      ATTR.helperRoutingDifficulty(rec.resolved.difficulty ?? rec.requested.difficulty ?? 'none'),
      ATTR.helperTaskProfile(rec.taskProfile ?? 'unspecified'),
      ATTR.orchestrator(cli(rec.resolved.provider)),
      ATTR.modelFamily(modelFamily(rec.resolved.model ?? undefined)),
      rec.resolved.model ? ATTR.helperModelHash(rec.resolved.model) : undefined,
      rec.requested.model ? ATTR.helperRequestedModelHash(rec.requested.model) : undefined,
      effortAttr(rec.resolved.effort),
      rec.source?.model ? ATTR.helperRoutingConfigSource(rec.source.model) : undefined,
      rec.reason ? ATTR.helperRoutingReason(rec.reason) : undefined,
      rec.fallback ? ATTR.helperRoutingFallback(rec.fallback) : undefined,
      rec.mappingRevision ? ATTR.helperMappingRevisionHash(rec.mappingRevision) : undefined,
      rec.mappingFingerprint ? ATTR.helperMappingFingerprintHash(rec.mappingFingerprint) : undefined,
      rec.mappingKind ? ATTR.helperMappingKind(rec.mappingKind) : undefined,
      ATTR.helperCandidateCount(rec.candidates.length),
      ATTR.helperEligibleCount(rec.candidates.filter((c) => c.eligible).length),
      rec.settings && ATTR.helperAutoEnabled(rec.settings.autoEnabled),
      rec.settings && ATTR.helperEnabledProviders(count(rec.settings.enabledProviders) ?? 0),
      t?.quotaLowBp !== undefined && ATTR.helperThresholdQuotaLowBp(t.quotaLowBp),
      t?.quotaNearLimitBp !== undefined && ATTR.helperThresholdQuotaNearBp(t.quotaNearLimitBp),
      t?.quotaStaleMs !== undefined && ATTR.helperThresholdQuotaStaleMs(t.quotaStaleMs),
      t?.reservationMs !== undefined && ATTR.helperThresholdReservationMs(t.reservationMs),
      t?.stickyMs !== undefined && ATTR.helperThresholdStickyMs(t.stickyMs),
      t?.loadMargin !== undefined && ATTR.helperThresholdLoadMargin(t.loadMargin),
      rec.cooldownsInForce && ATTR.helperCooldownsAuth(rec.cooldownsInForce.auth),
      rec.cooldownsInForce && ATTR.helperCooldownsQuota(rec.cooldownsInForce.quota),
      rec.cooldownsInForce && ATTR.helperCooldownsAvailability(rec.cooldownsInForce.availability),
      tie && ATTR.helperTieReason(tie.reason),
      tie && ATTR.helperTieSetSize(count(tie.setSize) ?? 0),
      tie?.bandBp !== undefined && ATTR.helperTieBandBp(tie.bandBp),
      tie?.byLoad !== undefined && ATTR.helperTieByLoad(tie.byLoad),
      tie?.cursorKey ? ATTR.helperTieCursorKeyHash(tie.cursorKey) : undefined,
      tie?.cursorBefore !== undefined && ATTR.helperTieCursorBefore(tie.cursorBefore),
      tie?.cursorAfter !== undefined && ATTR.helperTieCursorAfter(tie.cursorAfter),
      ...(forecast ? forecastAttrs(forecast) : []),
    ]);
    for (const c of candidates) {
      if (!admit()) break;
      emit('clubhouse.helper.decision.candidate', candidateAttrs(rec.decisionId, c));
    }
  });
}

function forecastAttrs(forecast: BurnForecast): Array<TelAttr | undefined> {
  return [
    ATTR.helperForecastWeeklySamples(forecast.weekly.samples),
    ATTR.helperForecastFiveHourSamples(forecast.fiveHour.samples),
    forecast.weekly.expectedBp !== undefined ? ATTR.helperForecastWeeklyBp(forecast.weekly.expectedBp) : undefined,
    forecast.fiveHour.expectedBp !== undefined ? ATTR.helperForecastFiveHourBp(forecast.fiveHour.expectedBp) : undefined,
  ];
}

function evaluateForecasts(provider: string, quota: QuotaView): void {
  const history = ledger.forecastHistory();
  for (const entry of history) {
    if (entry.provider !== provider) continue;
    const observation = observeHelperBurn(entry, history, quota, clock());
    if (!observation) continue;
    ledger.setBurnObservation(entry.helperId, observation);
    if (!admit()) continue;
    emit('clubhouse.helper.forecast', [
      ATTR.helperDecisionIdHash(entry.decisionId),
      observation.runId ? ATTR.helperRunIdHash(observation.runId) : undefined,
      ATTR.orchestrator(cli(provider)),
      entry.model ? ATTR.helperModelHash(entry.model) : undefined,
      effortAttr(entry.effort),
      ATTR.helperRoutingDifficulty(entry.difficulty ?? 'none'),
      ATTR.helperTaskProfile(entry.taskProfile ?? 'unspecified'),
      entry.mappingRevision ? ATTR.helperMappingRevisionHash(entry.mappingRevision) : undefined,
      ATTR.helperForecastReason(observation.reason),
      ATTR.helperForecastAttribution(observation.attribution),
      ATTR.helperForecastUsageSamples(entry.forecastRun?.usageSamples ?? 0),
      observation.weekly ? ATTR.helperForecastWeeklyObservedBp(observation.weekly.observedBp) : undefined,
      observation.fiveHour ? ATTR.helperForecastFiveHourObservedBp(observation.fiveHour.observedBp) : undefined,
      observation.weekly?.errorBp !== undefined ? ATTR.helperForecastWeeklyErrorBp(observation.weekly.errorBp) : undefined,
      observation.fiveHour?.errorBp !== undefined ? ATTR.helperForecastFiveHourErrorBp(observation.fiveHour.errorBp) : undefined,
    ]);
  }
}

// --- What became of it -------------------------------------------------------------

/** The chosen provider became (or failed to become) a running helper. */
export function recordHelperSpawnResult(rec: HelperSpawnResultRecord): void {
  guarded(() => {
    if (rec.helperId) bind(rec.decisionId, rec.helperId);
    const entry = (rec.helperId ? ledger.getEntry(rec.helperId) : undefined) ?? ledger.getEntryByDecision(rec.decisionId);
    if (entry && entry.decisionId === rec.decisionId) ledger.setSpawn(entry.helperId, rec.result);
    if (!admit()) return;
    const known = entry?.decisionId === rec.decisionId;
    const differs = !!rec.actual && !!entry && (
      rec.actual.provider !== entry.provider || rec.actual.model !== entry.model || rec.actual.effort !== entry.effort
    );
    emit('clubhouse.helper.spawn_result', [
      ATTR.helperSchemaVersion(HELPER_TELEMETRY_SCHEMA_VERSION),
      ATTR.helperDecisionIdHash(rec.decisionId),
      ATTR.helperDecisionKnown(known),
      rec.helperId ? ATTR.agentIdHash(rec.helperId) : undefined,
      ATTR.helperSpawnResult(rec.result),
      rec.cooldownKind ? ATTR.helperSpawnCooldown(rec.cooldownKind) : undefined,
      rec.actual && ATTR.orchestrator(cli(rec.actual.provider)),
      rec.actual?.model ? ATTR.helperRunModelHash(rec.actual.model) : undefined,
      rec.actual && ATTR.modelFamily(modelFamily(rec.actual.model ?? undefined)),
      rec.actual && effortAttr(rec.actual.effort),
      rec.actual && entry && ATTR.helperSpawnDiffers(differs),
      known && entry ? ATTR.helperDecisionAgeMs(Math.max(0, clock() - entry.decidedAtMs)) : undefined,
    ]);
  });
}

/** A wake or resume of an existing helper: reuse of its earlier decision, never a new one. */
export function recordHelperReuse(rec: HelperReuseRecord): void {
  guarded(() => {
    const entry = ledger.getEntry(rec.helperId);
    const ctx = runs.get(rec.helperId);
    if (ctx) {
      ctx.forecastUsable = false;
    } else if (entry) {
      const run = ledger.getRun(rec.helperId) ?? ledger.beginRun(rec.helperId, clock(), rec.kind === 'resume');
      ledger.setForecastRun(rec.helperId, {
        runId: run.runId, startedMs: run.startedMs, usageSamples: 0, usable: false,
      });
    }
    if (!admit()) return;
    emit('clubhouse.helper.reuse', [
      ATTR.helperSchemaVersion(HELPER_TELEMETRY_SCHEMA_VERSION),
      ATTR.agentIdHash(rec.helperId),
      ATTR.helperReuseKind(rec.kind),
      ATTR.helperDecisionKnown(!!entry),
      entry && ATTR.helperDecisionIdHash(entry.decisionId),
      entry && ATTR.helperDecisionAgeMs(Math.max(0, clock() - entry.decidedAtMs)),
      entry && ATTR.helperRoutingMode(entry.mode),
    ]);
  });
}

/** A helper was disposed. Its open run, if any, ends as disposed when its session ends, so final usage is kept. */
export function recordHelperDisposed(helperId: string): void {
  guarded(() => {
    const ctx = runs.get(helperId);
    if (ctx) {
      ctx.disposeRequested = true;
      return;
    }
    emitOutcome(helperId, undefined, undefined, 'disposed');
  });
}

// --- Plan-limit samples --------------------------------------------------------------

interface QuotaMemory {
  state: string;
  weeklyBp?: number;
  weeklyResets?: number;
  fiveBp?: number;
  fiveResets?: number;
  atMs: number;
  sampledAtMs: number;
  /** Times of this provider's samples in the past hour. */
  recent: number[];
}

const quotaMemory = new Map<string, QuotaMemory>();

function windowOf(view: QuotaWindowView | null | undefined): { bp?: number; resets?: number } {
  return { bp: bp(view?.usedPercent), resets: iso(view?.resetsAt) };
}

/**
 * A token-free reading of a CLI's plan limits finished. Sampled on the first
 * reading, when the state changes, when a window moved by a point or its reset
 * changed, and otherwise at most every 15 minutes; at most 12 an hour per provider.
 * The numbers are the provider's own, for its whole login: use outside Clubhouse
 * is in them, and nothing says whose use moved them.
 */
export function recordQuotaSample(provider: string, quota: QuotaView): void {
  guarded(() => {
    evaluateForecasts(provider, quota);
    const t = clock();
    const weekly = windowOf(quota.weekly);
    const five = windowOf(quota.fiveHour);
    const before = quotaMemory.get(provider);
    const moved = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) >= HELPER_TELEMETRY_LIMITS.quotaSampleChangeBp;
    const resetChanged = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) > 60_000;
    let why: 'first' | 'state_change' | 'window_change' | 'interval' | undefined;
    if (!before) why = 'first';
    else if (before.state !== quota.state) why = 'state_change';
    else if (t - before.sampledAtMs >= HELPER_TELEMETRY_LIMITS.quotaSampleMinGapMs
      && (moved(before.weeklyBp, weekly.bp) || moved(before.fiveBp, five.bp) || resetChanged(before.weeklyResets, weekly.resets) || resetChanged(before.fiveResets, five.resets))) why = 'window_change';
    else if (t - before.sampledAtMs >= HELPER_TELEMETRY_LIMITS.quotaSampleIntervalMs) why = 'interval';
    if (!why) return;
    const recent = (before?.recent ?? []).filter((x) => t - x < HOUR_MS);
    if (recent.length >= HELPER_TELEMETRY_LIMITS.maxQuotaSamplesPerProviderPerHour) return;
    if (!admit()) return;
    recent.push(t);

    // Observed change since the last sample, only with positive evidence that both readings are in one reset window:
    // both reset times known and equal. A missing reset time on either side proves nothing, so no delta and no claim either way.
    const windowState = (a: number | undefined, b: number | undefined): 'same' | 'changed' | 'unknown' =>
      a === undefined || b === undefined ? 'unknown' : resetChanged(a, b) ? 'changed' : 'same';
    const weekState = before ? windowState(before.weeklyResets, weekly.resets) : 'unknown';
    const fiveState = before ? windowState(before.fiveResets, five.resets) : 'unknown';
    const resetBetween = weekState === 'changed' || fiveState === 'changed' ? true : weekState === 'same' || fiveState === 'same' ? false : undefined;
    const limiting = quota.limitingWindow;
    emit('clubhouse.helper_quota.sample', [
      ATTR.helperSchemaVersion(HELPER_TELEMETRY_SCHEMA_VERSION),
      ATTR.orchestrator(cli(provider)),
      ATTR.helperQuotaTrigger(why),
      ATTR.helperQuotaMeasuredAtMs(t),
      ATTR.helperQuotaState(quota.state),
      ATTR.helperQuotaSource(quota.source),
      ATTR.helperQuotaUnknownReason(quota.unknownReason ?? 'none'),
      iso(quota.asOf) !== undefined && ATTR.helperQuotaAsOfMs(iso(quota.asOf)!),
      ATTR.helperQuotaLimitingWindow(!limiting ? 'none' : limiting === 'weekly' ? 'weekly' : limiting === 'fiveHour' ? 'fiveHour' : limiting.startsWith('model:') ? 'model' : 'other'),
      weekly.bp !== undefined && ATTR.helperQuotaWeeklyUsedBp(weekly.bp),
      weekly.resets !== undefined && ATTR.helperQuotaWeeklyResetsMs(weekly.resets),
      five.bp !== undefined && ATTR.helperQuotaFiveHourUsedBp(five.bp),
      five.resets !== undefined && ATTR.helperQuotaFiveHourResetsMs(five.resets),
      ATTR.helperQuotaOtherWindows((quota.modelWindows?.length ?? 0) + (quota.unreadableWindows?.length ?? 0)),
      before && ATTR.helperQuotaDeltaSpanMs(t - before.atMs),
      resetBetween !== undefined && ATTR.helperQuotaResetBetween(resetBetween),
      before && weekState === 'same' && before.weeklyBp !== undefined && weekly.bp !== undefined && ATTR.helperQuotaWeeklyDeltaBp(weekly.bp - before.weeklyBp),
      before && fiveState === 'same' && before.fiveBp !== undefined && five.bp !== undefined && ATTR.helperQuotaFiveHourDeltaBp(five.bp - before.fiveBp),
    ]);
    quotaMemory.set(provider, {
      state: quota.state, weeklyBp: weekly.bp, weeklyResets: weekly.resets, fiveBp: five.bp, fiveResets: five.resets,
      atMs: t, sampledAtMs: t, recent,
    });
  });
}

// --- Runs: usage and outcomes ---------------------------------------------------------

interface RunContext {
  helperId: string;
  driver: ChatEventDataMap['session_started']['driver'];
  provider: string;
  run: ledger.LedgerRun;
  tracker: RunUsageTracker;
  sessionIds: Set<string>;
  actualModel?: string;
  disposeRequested: boolean;
  forecastUsageSamples: number;
  forecastUsable: boolean;
}

/** The open run of each helper, by agent id. */
const runs = new Map<string, RunContext>();

function usageAttrs(ctx: RunContext, entry: ledger.LedgerEntry | undefined, sample: UsageSample): Array<TelAttr | undefined | false> {
  const f = sample.figures;
  return [
    ATTR.helperSchemaVersion(HELPER_TELEMETRY_SCHEMA_VERSION),
    ATTR.agentIdHash(ctx.helperId),
    ATTR.helperRunIdHash(ctx.run.runId),
    ATTR.helperDecisionKnown(!!entry),
    entry && ATTR.helperDecisionIdHash(entry.decisionId),
    ATTR.orchestrator(cli(ctx.provider)),
    ATTR.chatDriver(ctx.driver),
    ctx.actualModel ? ATTR.helperRunModelHash(ctx.actualModel) : undefined,
    ATTR.modelFamily(modelFamily(ctx.actualModel)),
    ATTR.helperUsageKind(sample.kind),
    ATTR.helperUsageSource(sample.source),
    ATTR.helperUsageDedup(sample.dedup),
    ATTR.helperUsageScope(sample.scope),
    sample.baseline && ATTR.helperUsageBaseline(sample.baseline),
    ATTR.helperUsageCompleteness(sample.completeness),
    ATTR.helperUsageMeasuredAtMs(sample.measuredAtMs),
    // Absent means the provider did not report it. Zero is a reported zero.
    f.input !== undefined && ATTR.helperUsageInputTokens(f.input),
    f.cachedInput !== undefined && ATTR.helperUsageCachedInputTokens(f.cachedInput),
    f.cacheWrite !== undefined && ATTR.helperUsageCacheWriteTokens(f.cacheWrite),
    f.output !== undefined && ATTR.helperUsageOutputTokens(f.output),
    f.reasoning !== undefined && ATTR.helperUsageReasoningTokens(f.reasoning),
    sample.turnIndex !== undefined && ATTR.helperUsageTurnIndex(sample.turnIndex),
    sample.durationMs !== undefined && ATTR.helperUsageTurnDurationMs(Math.max(0, sample.durationMs)),
    sample.reset !== undefined && ATTR.helperUsageReset(sample.reset),
    sample.subagentExcluded !== undefined && ATTR.helperUsageSubagentExcluded(sample.subagentExcluded),
  ];
}

function emitUsage(ctx: RunContext, sample: UsageSample | undefined): void {
  if (!sample) return;
  if (!admit()) {
    ctx.tracker.counts.samplesDropped++;
    ctx.forecastUsable = false;
    return;
  }
  if (sample.reset) ctx.forecastUsable = false;
  if (sample.kind === 'turn') {
    ctx.forecastUsageSamples++;
    if (sample.completeness !== 'complete' || sample.scope === 'unscoped' || sample.dedup === 'none') ctx.forecastUsable = false;
  }
  emit('clubhouse.helper.usage.sample', usageAttrs(ctx, ledger.getEntry(ctx.helperId), sample));
}

function emitOutcome(helperId: string, ctx: RunContext | undefined, endedMs: number | undefined, outcome: HelperRunOutcome): void {
  if (!admit()) return;
  const entry = ledger.getEntry(helperId);
  const counts = ctx?.tracker.counts;
  emit('clubhouse.helper.outcome', [
    ATTR.helperSchemaVersion(HELPER_TELEMETRY_SCHEMA_VERSION),
    ATTR.agentIdHash(helperId),
    ATTR.helperDecisionKnown(!!entry),
    entry && ATTR.helperDecisionIdHash(entry.decisionId),
    ctx && ATTR.helperRunIdHash(ctx.run.runId),
    ATTR.helperRunOutcome(outcome),
    ctx && ATTR.orchestrator(cli(ctx.provider)),
    ctx && ATTR.chatDriver(ctx.driver),
    ctx?.actualModel ? ATTR.helperRunModelHash(ctx.actualModel) : undefined,
    ctx && ATTR.helperRunNativeResumed(ctx.run.nativeResumed),
    ctx && endedMs !== undefined && ATTR.helperRunDurationMs(Math.max(0, endedMs - ctx.run.startedMs)),
    counts && ATTR.helperRunTurns(counts.turns),
    counts && ATTR.helperUsageTurnsMissing(counts.turnsMissing),
    counts && ATTR.helperRunAuthErrors(counts.authErrors),
    counts && ATTR.helperRunRateLimitErrors(counts.rateLimitErrors),
    counts && ATTR.helperRunQuotaErrors(counts.quotaErrors),
    counts && ATTR.helperRunUsageSamplesDropped(counts.samplesDropped),
    entry && ATTR.helperDecisionAgeMs(Math.max(0, (endedMs ?? clock()) - entry.decidedAtMs)),
  ]);
}

/** End a helper's open run once: its closing usage samples, then its outcome. */
function finishRun(helperId: string, endedMs: number, outcome: HelperRunOutcome): void {
  const ctx = runs.get(helperId);
  if (!ctx) return;
  runs.delete(helperId);
  ledger.endRun(helperId, endedMs);
  try {
    for (const sample of ctx.tracker.finalSamples(endedMs)) emitUsage(ctx, sample);
    ledger.setForecastRun(helperId, {
      runId: ctx.run.runId, startedMs: ctx.run.startedMs, endedMs, usageSamples: ctx.forecastUsageSamples,
      outcomeHandled: true,
      usable: ctx.forecastUsable && outcome === 'completed' && !ctx.disposeRequested
        && !ctx.tracker.hasOpenTurns && ctx.tracker.counts.turnsMissing === 0 && ctx.tracker.counts.samplesDropped === 0,
    });
    emitOutcome(helperId, ctx, endedMs, ctx.disposeRequested ? 'disposed' : outcome);
  } finally {
    // The closed run is forgotten only now, after its final events went out.
    ledger.forgetRun(helperId);
  }
}

function outcomeOf(reason: ChatEventDataMap['session_ended']['reason'], exitCode: number | undefined): HelperRunOutcome {
  if (reason === 'stopped') return 'cancelled';
  if (reason === 'error') return 'failed';
  if (reason === 'idle_timeout') return 'completed';
  return exitCode === undefined || exitCode === 0 ? 'completed' : 'failed';
}

/** Fold one chat event into a helper run. Exported for tests; the bus calls it once installed. */
export function handleHelperChatEvent(event: ChatEvent): void {
  try {
    if (!isTelemetryActive()) {
      runs.clear();
      ledger.clearRuns();
      return;
    }
    const agentId = event.agentId;
    if (event.type === 'session_started') {
      const entry = ledger.getEntry(agentId);
      // Only helpers a decision was recorded for: orchestrators and other agents are not measured here.
      if (!entry) return;
      const existing = runs.get(agentId);
      const d = event.data;
      if (existing) {
        // A context clear starts a new chat session on the same run.
        existing.sessionIds.add(event.sessionId);
        existing.forecastUsable = false;
        return;
      }
      const forecastUsable = !d.resumed && !entry.forecastRun && d.provider === entry.provider && d.model === entry.model;
      const run = ledger.beginRun(agentId, event.ts, d.resumed === true);
      ledger.setForecastRun(agentId, { runId: run.runId, startedMs: event.ts, usageSamples: 0, usable: forecastUsable });
      runs.set(agentId, {
        helperId: agentId,
        driver: d.driver,
        provider: d.provider,
        run,
        tracker: new RunUsageTracker(d.driver, undefined, d.resumed === true),
        sessionIds: new Set([event.sessionId]),
        actualModel: d.model,
        disposeRequested: false,
        forecastUsageSamples: 0,
        forecastUsable,
      });
      return;
    }
    const ctx = runs.get(agentId);
    if (!ctx || !ctx.sessionIds.has(event.sessionId)) return;
    switch (event.type) {
      case 'session_info':
        if (event.data.model) {
          ctx.actualModel = event.data.model;
          if (event.data.model !== ledger.getEntry(agentId)?.model) ctx.forecastUsable = false;
        }
        return;
      case 'model_changed':
        ctx.actualModel = event.data.modelId;
        ctx.forecastUsable = false;
        return;
      case 'turn_started':
        ctx.tracker.turnStarted(event.turnId, event.ts);
        return;
      case 'usage':
        ctx.tracker.usage(event.data, event.turnId);
        return;
      case 'error':
        ctx.tracker.error(event.data.code);
        return;
      case 'subagent':
        ctx.tracker.subagentDeclared(event.data.subagentId);
        return;
      case 'turn_ended':
        if (event.data.stopReason !== 'end_turn') ctx.forecastUsable = false;
        emitUsage(ctx, ctx.tracker.turnEnded(event.turnId, event.data, event.ts));
        return;
      case 'session_ended': {
        if (event.data.reason === 'fallback') {
          // Not a chat run: the helper dropped to the terminal.
          runs.delete(agentId);
          ledger.setForecastRun(agentId, { runId: ctx.run.runId, startedMs: ctx.run.startedMs, usageSamples: 0, usable: false });
          return;
        }
        ctx.sessionIds.delete(event.sessionId);
        finishRun(agentId, event.ts, outcomeOf(event.data.reason, event.data.exitCode));
        return;
      }
      default:
        return;
    }
  } catch {
    // A telemetry fault never reaches the chat bus.
  }
}

function handleAgentExit(agentId: string, exitCode: number): void {
  guarded(() => {
    const t = clock();
    if (runs.has(agentId)) {
      finishRun(agentId, t, exitCode === 0 ? 'completed' : 'failed');
      return;
    }
    // A helper that ran in the terminal: an outcome without usage.
    const entry = ledger.getEntry(agentId);
    if (entry) {
      // Chat end already emitted its outcome and closed the same process's evidence.
      if (entry.forecastRun?.outcomeHandled) return;
      ledger.endRun(agentId, t);
      ledger.setForecastRun(agentId, {
        ...(entry.forecastRun?.runId && { runId: entry.forecastRun.runId }),
        startedMs: entry.forecastRun?.startedMs ?? entry.decidedAtMs, endedMs: t, usageSamples: 0, usable: false, outcomeHandled: true,
      });
      emitOutcome(agentId, undefined, undefined, exitCode === 0 ? 'completed' : 'failed');
      ledger.forgetRun(agentId);
    }
  });
}

// --- Wiring ----------------------------------------------------------------------------

let unsubscribe: Array<() => void> = [];

/** Point the join ledger at its file and start watching helper runs. Call once at startup. */
export function installHelperUsageTelemetry(options: { ledgerFile: string; onLedgerFailure?: (error: unknown) => void }): void {
  if (unsubscribe.length > 0) return;
  ledger.configureLedger({ file: options.ledgerFile, onFailure: options.onLedgerFailure });
  unsubscribe = [onChatEvent(handleHelperChatEvent), onAgentExit(handleAgentExit)];
}

/** Events dropped for the hourly budget since start, for diagnostics. */
export function helperTelemetryDropped(): number {
  return budgetDropped;
}

/** Test-only reset. */
export function _resetHelperUsageForTests(options: { now?: () => number } = {}): void {
  for (const off of unsubscribe) off();
  unsubscribe = [];
  runs.clear();
  pendingDecisions.clear();
  quotaMemory.clear();
  budgetWindowStart = 0;
  budgetUsed = 0;
  budgetDropped = 0;
  clock = options.now ?? Date.now;
  ledger._resetLedgerForTests();
}
