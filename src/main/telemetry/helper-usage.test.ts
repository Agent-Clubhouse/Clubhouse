import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAttributeSpec, type TelAttr } from '../../shared/telemetry/attributes';
import type { ChatEvent, ChatEventType } from '../../shared/chat/events';
import { HELPER_TELEMETRY_LIMITS, type DecisionCandidate, type HelperDecisionRecord } from '../../shared/telemetry/helper-usage-contract';
import type { QuotaView } from '../../shared/helper-routing';
import { broadcastAgentExit } from '../services/agent-exit-broadcast';
import { abortPending, setLocalSink, setRuntime } from './facade';
import { passThroughSink } from './__test-utils__/producing-runtime';
import * as ledger from './helper-decision-ledger';
import {
  _resetHelperUsageForTests,
  bindHelperDecision,
  handleHelperChatEvent,
  installHelperUsageTelemetry,
  newDecisionId,
  recordHelperDecision,
  recordHelperDisposed,
  recordHelperReuse,
  recordHelperSpawnResult,
  recordQuotaSample,
} from './helper-usage';
import type { EventOptions, LocalTelemetrySink, TelemetryRuntime } from './types';

interface Captured { name: string; attrs: Record<string, unknown>; kinds: Record<string, string>; opts?: EventOptions }
let local: Captured[] = [];
let exported: string[] = [];
let dir: string;
let now: number;

function install(level: LocalTelemetrySink['level'] = 'standard'): void {
  const sink: LocalTelemetrySink = {
    ...passThroughSink(level),
    event: (name: string, attrs: TelAttr[] = [], opts?: EventOptions) => {
      local.push({ name, attrs: Object.fromEntries(attrs.map((a) => [a.key, a.value])), kinds: Object.fromEntries(attrs.map((a) => [a.key, a.kind])), opts });
    },
  };
  setLocalSink(sink);
  setRuntime({
    level, event: (name: string) => exported.push(name),
    flow: vi.fn(), step: vi.fn(), count: vi.fn(), exception: vi.fn(), replaySpan: vi.fn(), replayTree: vi.fn(),
    preview: (): never[] => [], recentExports: (): never[] => [], forceFlush: async () => {}, shutdown: async () => {},
  } as unknown as TelemetryRuntime);
}

const events = (name: string) => local.filter((e) => e.name === name);

beforeEach(() => {
  local = [];
  exported = [];
  now = 1_700_000_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-usage-'));
  _resetHelperUsageForTests({ now: () => now });
  ledger.configureLedger({ file: path.join(dir, 'ledger.json'), now: () => now });
  install();
});

afterEach(async () => {
  await ledger.flushLedger();
  _resetHelperUsageForTests();
  setRuntime(null);
  setLocalSink(null);
  abortPending();
  fs.rmSync(dir, { recursive: true, force: true });
});

const candidate = (provider: string, over: Partial<DecisionCandidate> = {}): DecisionCandidate => ({
  provider, eligible: true, load: { live: 1, reserved: 0 },
  mapped: { model: provider === 'claude-code' ? 'claude-sonnet-5-5' : 'gpt-6.1-terra', effort: 'medium', source: 'builtin_mapping', verified: true },
  quota: {
    state: 'known', source: 'cli_query', asOfMs: now - 60_000, quality: 'fresh',
    windows: [{ name: 'weekly', usedBp: 4200, resetsAtMs: now + 86_400_000 }, { name: 'fiveHour', usedBp: 1500, resetsAtMs: now + 3_600_000 }],
  },
  ...over,
});

function decision(over: Partial<HelperDecisionRecord> = {}): HelperDecisionRecord {
  return {
    decisionId: newDecisionId(), decidedAtMs: now, policyVersion: 1, mode: 'auto', outcome: 'chosen', helperId: 'helper-1',
    requested: { provider: 'auto', model: null, effort: null, difficulty: 'medium' },
    resolved: { provider: 'claude-code', model: 'claude-sonnet-5-5', effort: 'medium', difficulty: 'medium' },
    source: { model: 'builtin_mapping' }, reason: 'lower_load', fallback: 'none',
    mappingRevision: 'rev-7', mappingFingerprint: 'fp-abc', mappingKind: 'builtin',
    settings: { autoEnabled: true, enabledProviders: 2 },
    candidates: [candidate('claude-code', { chosen: true }), candidate('codex-cli', { eligible: false, excluded: 'quota_near_limit' })],
    tie: { setSize: 2, bandBp: 0, reason: 'lower_load', byLoad: true },
    thresholds: { quotaLowBp: 8000, quotaNearLimitBp: 9500, loadMargin: 2 },
    ...over,
  };
}

function chat(type: ChatEventType, data: unknown, extra: { agentId?: string; sessionId?: string; turnId?: string; ts?: number } = {}): ChatEvent {
  return { v: 2, agentId: extra.agentId ?? 'helper-1', sessionId: extra.sessionId ?? 's1', turnId: extra.turnId, seq: 1, ts: extra.ts ?? now, type, data } as ChatEvent;
}

const started = (agentId = 'helper-1', over: Record<string, unknown> = {}) =>
  handleHelperChatEvent(chat('session_started', { driver: 'claude_stream_json', provider: 'claude-code', cwd: '/x', resumed: false, model: 'claude-sonnet-5-5', capabilities: {}, ...over }, { agentId }));

describe('Stage 3 shadow forecasts', () => {
  function run(helperId: string, model = 'claude-sonnet-5-5'): void {
    started(helperId, { driver: 'claude_agent_sdk', model });
    handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { agentId: helperId, turnId: 't', ts: now + 1 }));
    handleHelperChatEvent(chat('usage', { scope: 'turn', coverage: 'main', tokens: { input: 100, output: 10 } }, { agentId: helperId, turnId: 't', ts: now + 2 }));
    handleHelperChatEvent(chat('turn_ended', { stopReason: 'end_turn', usage: { input: 100, output: 10 } }, { agentId: helperId, turnId: 't', ts: now + 3 }));
    handleHelperChatEvent(chat('session_ended', { reason: 'idle_timeout' }, { agentId: helperId, ts: now + 4 }));
  }

  it('joins complete usage to later quota intervals, persists immutable predictions and records errors locally only', async () => {
    const reset = now + 86_400_000;
    let lastPrediction: unknown;
    for (let i = 0; i < 6; i++) {
      const rec = decision({ decisionId: `forecast-${i}`, helperId: `h-${i}`, candidates: [
        candidate('claude-code', { chosen: true, quota: {
          state: 'known', source: 'cli_query', quality: 'fresh', asOfMs: now,
          windows: [{ name: 'weekly', usedBp: i * 100, resetsAtMs: reset }],
        } }),
      ] });
      recordHelperDecision(rec);
      lastPrediction = structuredClone(ledger.getEntry(`h-${i}`)?.forecast);
      run(`h-${i}`);
      now += 10;
      recordQuotaSample('claude-code', {
        state: 'known', source: 'cli_query', asOf: new Date(now).toISOString(),
        weekly: { usedPercent: i + (i === 5 ? 2 : 1), resetsAt: new Date(reset).toISOString() },
      });
      expect(ledger.getEntry(`h-${i}`)?.forecast).toEqual(lastPrediction);
      now += 60_000;
    }
    expect(ledger.getEntry('h-5')).toMatchObject({
      forecast: { weekly: { samples: 5, expectedBp: 100 } },
      burnObservation: { reason: 'observed', attribution: 'whole_login_unknown', weekly: { observedBp: 200, errorBp: 100 } },
    });
    const observation = events('clubhouse.helper.forecast').at(-1)!;
    expect(observation.attrs).toMatchObject({
      'clubhouse.helper_forecast.weekly_error_bp': 100, 'clubhouse.helper_forecast.attribution': 'whole_login_unknown',
    });
    expect(observation.opts?.localOnly).toBe(true);
    expect(exported).toEqual([]);
    await ledger.flushLedger();
    ledger.configureLedger({ file: path.join(dir, 'ledger.json'), now: () => now });
    expect(ledger.getEntry('h-5')?.forecast).toEqual(lastPrediction);
    expect(ledger.getEntry('h-5')?.burnObservation?.weekly?.errorBp).toBe(100);
    recordQuotaSample('claude-code', {
      state: 'known', source: 'cli_query', asOf: new Date(now).toISOString(),
      weekly: { usedPercent: 10, resetsAt: new Date(reset).toISOString() },
    });
    expect(events('clubhouse.helper.forecast')).toHaveLength(6);
  });

  it('does not calibrate changed model identity or write telemetry-off decisions', () => {
    recordHelperDecision(decision());
    run('helper-1', 'different-model');
    recordQuotaSample('claude-code', {
      state: 'known', source: 'cli_query', asOf: new Date(now + 20).toISOString(),
      weekly: { usedPercent: 50, resetsAt: new Date(now + 86_400_000).toISOString() },
    });
    expect(ledger.getEntry('helper-1')?.burnObservation?.reason).toBe('incomplete');
    setLocalSink(null);
    setRuntime(null);
    const size = ledger.ledgerSize();
    recordHelperDecision(decision({ helperId: 'off' }));
    expect(ledger.ledgerSize()).toBe(size);
    expect(ledger.getEntry('off')).toBeUndefined();
  });

  it('preserves completed chat evidence when its later process exit arrives, and joins the exact usage run', () => {
    installHelperUsageTelemetry({ ledgerFile: path.join(dir, 'ledger.json') });
    recordHelperDecision(decision());
    run('helper-1');
    const evidence = structuredClone(ledger.getEntry('helper-1')?.forecastRun);
    broadcastAgentExit('helper-1', 0);
    expect(ledger.getEntry('helper-1')?.forecastRun).toEqual(evidence);
    recordQuotaSample('claude-code', {
      state: 'known', source: 'cli_query', asOf: new Date(now + 20).toISOString(),
      weekly: { usedPercent: 50, resetsAt: new Date(now + 86_400_000).toISOString() },
    });
    const observation = events('clubhouse.helper.forecast')[0];
    expect(observation.attrs['clubhouse.helper_run.id_hash']).toBe(evidence?.runId);
  });

  it('keeps a chat-to-terminal fallback overlapping until the process actually exits', () => {
    installHelperUsageTelemetry({ ledgerFile: path.join(dir, 'ledger.json') });
    recordHelperDecision(decision());
    started('helper-1', { driver: 'claude_agent_sdk' });
    handleHelperChatEvent(chat('session_ended', { reason: 'fallback' }, { ts: now + 4 }));
    expect(ledger.getEntry('helper-1')?.forecastRun?.endedMs).toBeUndefined();
    now += 10;
    broadcastAgentExit('helper-1', 0);
    expect(ledger.getEntry('helper-1')?.forecastRun).toMatchObject({ endedMs: now, usable: false });
  });

  it.each(['reset', 'dropped_final'])('excludes %s evidence discovered only in the closing usage samples', (scenario) => {
    recordHelperDecision(decision());
    started('helper-1', { driver: 'claude_agent_sdk' });
    handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { turnId: 't' }));
    handleHelperChatEvent(chat('usage', { scope: 'turn', coverage: 'main', tokens: { input: 100, output: 10 } }, { turnId: 't' }));
    handleHelperChatEvent(chat('turn_ended', { stopReason: 'end_turn', usage: { input: 100, output: 10 } }, { turnId: 't' }));
    handleHelperChatEvent(chat('usage', { scope: 'session', coverage: 'inclusive', tokens: { input: 100, output: 10 } }));
    if (scenario === 'reset') {
      handleHelperChatEvent(chat('usage', { scope: 'session', coverage: 'inclusive', tokens: { input: 1, output: 1 } }));
    } else {
      for (let i = 0; i < HELPER_TELEMETRY_LIMITS.maxEventsPerHour; i++) {
        recordHelperReuse({ helperId: 'unrelated', kind: 'wake' });
      }
    }
    handleHelperChatEvent(chat('session_ended', { reason: 'idle_timeout' }, { ts: now + 4 }));
    expect(ledger.getEntry('helper-1')?.forecastRun).toMatchObject({ usageSamples: 1, usable: false });
    recordQuotaSample('claude-code', {
      state: 'known', source: 'cli_query', asOf: new Date(now + 20).toISOString(),
      weekly: { usedPercent: 50, resetsAt: new Date(now + 86_400_000).toISOString() },
    });
    expect(ledger.getEntry('helper-1')?.burnObservation?.reason).toBe('incomplete');
  });

  it.each(['missing_usage', 'resumed', 'cancelled'])('leaves %s runs ineligible for calibration', (scenario) => {
    recordHelperDecision(decision());
    if (scenario === 'missing_usage') {
      started('helper-1', { driver: 'claude_agent_sdk' });
      handleHelperChatEvent(chat('session_ended', { reason: 'idle_timeout' }, { ts: now + 4 }));
    } else if (scenario === 'resumed') {
      started('helper-1', { driver: 'claude_agent_sdk', resumed: true });
      handleHelperChatEvent(chat('session_ended', { reason: 'idle_timeout' }, { ts: now + 4 }));
    } else {
      started('helper-1', { driver: 'claude_agent_sdk' });
      handleHelperChatEvent(chat('session_ended', { reason: 'stopped' }, { ts: now + 4 }));
    }
    recordQuotaSample('claude-code', {
      state: 'known', source: 'cli_query', asOf: new Date(now + 20).toISOString(),
      weekly: { usedPercent: 50, resetsAt: new Date(now + 86_400_000).toISOString() },
    });
    expect(ledger.getEntry('helper-1')?.burnObservation?.reason).toBe('incomplete');
  });

  it.each(['cancelled', 'error', 'timeout', 'max_tokens', 'max_turns', 'refusal', 'unfinished'])(
    'excludes a %s later turn without changing existing usage or outcome records',
    (stopReason) => {
      recordHelperDecision(decision());
      started('helper-1', { driver: 'claude_agent_sdk' });
      for (const turnId of ['complete', 'later']) {
        handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { turnId }));
        handleHelperChatEvent(chat('usage', { scope: 'turn', coverage: 'main', tokens: { input: 100, output: 10 } }, { turnId }));
        if (turnId === 'later' && stopReason === 'unfinished') continue;
        handleHelperChatEvent(chat('turn_ended', { stopReason: turnId === 'complete' ? 'end_turn' : stopReason }, { turnId }));
      }
      handleHelperChatEvent(chat('session_ended', { reason: 'process_exit', exitCode: 0 }, { ts: now + 4 }));
      const turns = stopReason === 'unfinished' ? 1 : 2;
      expect(events('clubhouse.helper.usage.sample')).toHaveLength(turns);
      expect(events('clubhouse.helper.outcome')[0].attrs).toMatchObject({
        'clubhouse.helper_run.outcome': 'completed', 'clubhouse.helper_run.turns': turns,
        'clubhouse.helper_usage.turns_missing': 0,
      });
      recordQuotaSample('claude-code', {
        state: 'known', source: 'cli_query', asOf: new Date(now + 20).toISOString(),
        weekly: { usedPercent: 50, resetsAt: new Date(now + 86_400_000).toISOString() },
      });
      expect(ledger.getEntry('helper-1')?.burnObservation?.reason).toBe('incomplete');
    },
  );
});

describe('decisions', () => {
  it('records an Auto decision with every provider, quota, load and tie input, local only', () => {
    recordHelperDecision(decision());
    const [d] = events('clubhouse.helper.decision');
    expect(d.attrs).toMatchObject({
      'clubhouse.helper_decision.outcome': 'chosen',
      'clubhouse.helper_routing.mode': 'auto',
      'clubhouse.helper_routing.reason': 'lower_load',
      'clubhouse.helper_decision.candidates': 2,
      'clubhouse.helper_decision.eligible': 1,
      'clubhouse.helper_decision.quota_near_limit_bp': 9500,
      'clubhouse.helper_tie.band_bp': 0,
      'clubhouse.helper_tie.by_load': true,
      'clubhouse.helper_decision.task_profile': 'unspecified',
      'clubhouse.model.family': 'sonnet',
    });
    const [chosen, skipped] = events('clubhouse.helper.decision.candidate');
    expect(chosen.attrs).toMatchObject({
      'clubhouse.helper_candidate.eligible': true, 'clubhouse.helper_candidate.chosen': true, 'clubhouse.helper_candidate.excluded': 'none',
      'clubhouse.helper_candidate.load_live': 1, 'clubhouse.helper_candidate.load_reserved': 0,
      'clubhouse.helper_quota.weekly_used_bp': 4200, 'clubhouse.helper_quota.five_hour_used_bp': 1500, 'clubhouse.helper_quota.state': 'known',
      'clubhouse.helper_quota.source': 'cli_query',
    });
    expect(skipped.attrs).toMatchObject({ 'clubhouse.helper_candidate.eligible': false, 'clubhouse.helper_candidate.excluded': 'quota_near_limit' });
    // Never leaves the machine.
    for (const e of local) expect(e.opts?.localOnly).toBe(true);
    expect(exported).toEqual([]);
  });

  it('keeps different mapped models distinguishable without exporting a raw id', () => {
    recordHelperDecision(decision({ decisionId: 'a', resolved: { provider: 'claude-code', model: 'claude-sonnet-5-5', effort: 'medium', difficulty: 'medium' } }));
    recordHelperDecision(decision({ decisionId: 'b', helperId: 'helper-2', resolved: { provider: 'claude-code', model: 'claude-opus-5-5', effort: 'high', difficulty: 'hard' } }));
    const [a, b] = events('clubhouse.helper.decision');
    expect(a.kinds['clubhouse.helper_decision.model_hash']).toBe('hash');
    expect(a.attrs['clubhouse.helper_decision.model_hash']).not.toBe(b.attrs['clubhouse.helper_decision.model_hash']);
    expect(a.attrs['clubhouse.model.family']).toBe('sonnet');
    expect(b.attrs['clubhouse.model.family']).toBe('opus');
    expect(a.attrs['clubhouse.helper_decision.mapping_fingerprint_hash']).toBe('fp-abc');
    expect(a.kinds['clubhouse.helper_decision.mapping_fingerprint_hash']).toBe('hash');
  });

  it('records a refused decision with no helper, and puts nothing in the ledger', () => {
    recordHelperDecision(decision({
      outcome: 'refused', refusalCode: 'no_candidate', helperId: undefined, reason: undefined, fallback: undefined, source: undefined,
      resolved: { provider: null, model: null, effort: null, difficulty: 'hard' },
      candidates: [candidate('claude-code', { eligible: false, excluded: 'cooling_down' })],
    }));
    const [d] = events('clubhouse.helper.decision');
    expect(d.attrs['clubhouse.helper_decision.outcome']).toBe('refused');
    expect(d.attrs['clubhouse.helper_auto.refusal']).toBe('no_candidate');
    expect(d.attrs).not.toHaveProperty('clubhouse.agent.id_hash');
    // No reason is made up for a choice that was not made.
    expect(d.attrs).not.toHaveProperty('clubhouse.helper_routing.reason');
    expect(d.attrs).not.toHaveProperty('clubhouse.helper_routing.config_source');
    expect(ledger.ledgerSize()).toBe(0);
  });

  it('represents explicit and preset starts with no candidates and no tie', () => {
    recordHelperDecision(decision({ mode: 'explicit', reason: 'explicit_request', candidates: [], tie: undefined, thresholds: undefined, settings: undefined, source: { model: 'request' }, requested: { provider: 'codex-cli', model: 'gpt-6.1-terra', effort: 'low', difficulty: null }, resolved: { provider: 'codex-cli', model: 'gpt-6.1-terra', effort: 'low', difficulty: null } }));
    const [d] = events('clubhouse.helper.decision');
    expect(d.attrs).toMatchObject({ 'clubhouse.helper_routing.mode': 'explicit', 'clubhouse.helper_decision.candidates': 0, 'clubhouse.helper_routing.requested_cli': 'codex-cli' });
    expect(d.attrs).not.toHaveProperty('clubhouse.helper_tie.reason');
    expect(events('clubhouse.helper.decision.candidate')).toEqual([]);
  });

  it('states unavailable quota as unavailable: no percent attribute, never zero', () => {
    recordHelperDecision(decision({
      candidates: [candidate('claude-code', { chosen: true, quota: { state: 'unknown', source: 'none', unknownReason: 'not_read', quality: 'unknown' } })],
    }));
    const [c] = events('clubhouse.helper.decision.candidate');
    expect(c.attrs).toMatchObject({ 'clubhouse.helper_quota.state': 'unknown', 'clubhouse.helper_quota.unknown_reason': 'not_read' });
    expect(c.attrs).not.toHaveProperty('clubhouse.helper_quota.weekly_used_bp');
    expect(c.attrs).not.toHaveProperty('clubhouse.helper_quota.as_of_ms');
  });

  it('keeps a real zero percent as zero', () => {
    recordHelperDecision(decision({ candidates: [candidate('claude-code', { quota: { state: 'known', source: 'cli_query', windows: [{ name: 'weekly', usedBp: 0 }] } })] }));
    expect(events('clubhouse.helper.decision.candidate')[0].attrs['clubhouse.helper_quota.weekly_used_bp']).toBe(0);
  });

  it('records policy score and rotation inputs when a policy has them', () => {
    recordHelperDecision(decision({
      candidates: [candidate('claude-code', { chosen: true, tier: 1, score: { basis: 'weekly_used', weeklyUsedBp: 4200, cyclePhaseBp: 3000, targetBp: 3000, pressureBp: 1200, rank: 0 } })],
      tie: { setSize: 2, reason: 'rotation', cursorKey: 'claude-code|medium', cursorBefore: 3, cursorAfter: 4 },
    }));
    expect(events('clubhouse.helper.decision.candidate')[0].attrs).toMatchObject({
      'clubhouse.helper_candidate.score_basis': 'weekly_used', 'clubhouse.helper_candidate.score_pressure_bp': 1200,
      'clubhouse.helper_candidate.tier': 1, 'clubhouse.helper_candidate.rank': 0,
    });
    const d = events('clubhouse.helper.decision')[0];
    expect(d.attrs).toMatchObject({ 'clubhouse.helper_tie.reason': 'rotation', 'clubhouse.helper_tie.cursor_before': 3, 'clubhouse.helper_tie.cursor_after': 4 });
    expect(d.kinds['clubhouse.helper_tie.cursor_key_hash']).toBe('hash');
  });

  it('emits only registered attributes and never a prompt, path or raw model id outside hashes', () => {
    recordHelperDecision(decision());
    recordHelperSpawnResult({ decisionId: 'x', helperId: 'helper-1', result: 'started', actual: { provider: 'claude-code', model: 'claude-sonnet-5-5', effort: 'medium' } });
    for (const e of local) {
      for (const [key, value] of Object.entries(e.attrs)) {
        expect(getAttributeSpec(key), key).toBeDefined();
        if (e.kinds[key] !== 'hash' && typeof value === 'string') expect(value).not.toMatch(/claude-sonnet-5-5|helper-1|\/|rev-7|fp-abc/);
      }
    }
  });

  it('is silent while telemetry is off, and then leaves no ledger entry', () => {
    setLocalSink(null);
    setRuntime(null);
    recordHelperDecision(decision());
    expect(local).toEqual([]);
    expect(ledger.getEntry('helper-1')).toBeUndefined();
  });

  it('is silent below the standard level', () => {
    install('errors');
    recordHelperDecision(decision());
    expect(local).toEqual([]);
    expect(ledger.getEntry('helper-1')).toBeUndefined();
  });

  it('never throws into routing', () => {
    expect(() => recordHelperDecision(null as never)).not.toThrow();
    expect(() => recordHelperSpawnResult(null as never)).not.toThrow();
    expect(() => recordHelperReuse(null as never)).not.toThrow();
  });
});

describe('what became of a decision', () => {
  it('records started, left asleep, failed with cooldown, refused and cancelled apart from the decision', () => {
    const rec = decision();
    recordHelperDecision(rec);
    recordHelperSpawnResult({ decisionId: rec.decisionId, helperId: 'helper-1', result: 'left_asleep' });
    recordHelperSpawnResult({ decisionId: rec.decisionId, helperId: 'helper-1', result: 'spawn_failed', cooldownKind: 'auth' });
    recordHelperSpawnResult({ decisionId: 'other', result: 'creation_refused' });
    recordHelperSpawnResult({ decisionId: 'other-2', result: 'cancelled' });
    const results = events('clubhouse.helper.spawn_result').map((e) => [e.attrs['clubhouse.helper_spawn.result'], e.attrs['clubhouse.helper_decision.known'], e.attrs['clubhouse.helper_spawn.cooldown']]);
    expect(results).toEqual([
      ['left_asleep', true, undefined],
      ['spawn_failed', true, 'auth'],
      ['creation_refused', false, undefined],
      ['cancelled', false, undefined],
    ]);
    expect(events('clubhouse.helper.decision')).toHaveLength(1);
    expect(ledger.getEntry('helper-1')?.spawn).toBe('spawn_failed');
  });

  it('marks when the helper that launched differs from the decision', () => {
    const rec = decision();
    recordHelperDecision(rec);
    recordHelperSpawnResult({ decisionId: rec.decisionId, helperId: 'helper-1', result: 'started', actual: { provider: 'codex-cli', model: 'gpt-6.1-terra', effort: 'medium' } });
    const [r] = events('clubhouse.helper.spawn_result');
    expect(r.attrs['clubhouse.helper_spawn.differs_from_decision']).toBe(true);
    expect(r.attrs['clubhouse.orchestrator']).toBe('codex-cli');
    expect(r.attrs['clubhouse.helper_decision.age_ms']).toBe(0);
  });

  it('binds a helper id given after the decision, before the helper launches', () => {
    const rec = decision({ helperId: undefined });
    recordHelperDecision(rec);
    expect(ledger.getEntry('helper-1')).toBeUndefined();
    bindHelperDecision(rec.decisionId, 'helper-1');
    expect(ledger.getEntry('helper-1')?.decisionId).toBe(rec.decisionId);
  });
});

describe('reuse', () => {
  it('records a wake as reuse of the earlier decision with its age, and never as a new decision', () => {
    const rec = decision();
    recordHelperDecision(rec);
    now += 3_600_000;
    recordHelperReuse({ helperId: 'helper-1', kind: 'wake' });
    expect(events('clubhouse.helper.decision')).toHaveLength(1);
    const [reuse] = events('clubhouse.helper.reuse');
    expect(reuse.attrs).toMatchObject({ 'clubhouse.helper_reuse.kind': 'wake', 'clubhouse.helper_decision.known': true, 'clubhouse.helper_decision.age_ms': 3_600_000 });
    expect(reuse.attrs['clubhouse.helper_decision.id_hash']).toBe(rec.decisionId);
  });

  it('says unknown when the ledger has no decision for the helper', () => {
    recordHelperReuse({ helperId: 'older-helper', kind: 'resume' });
    const [reuse] = events('clubhouse.helper.reuse');
    expect(reuse.attrs['clubhouse.helper_decision.known']).toBe(false);
    expect(reuse.attrs).not.toHaveProperty('clubhouse.helper_decision.id_hash');
  });
});

describe('usage through a helper run', () => {
  beforeEach(() => {
    const rec = decision();
    recordHelperDecision(rec);
    recordHelperSpawnResult({ decisionId: rec.decisionId, helperId: 'helper-1', result: 'started' });
    local = [];
  });

  it('joins turn usage to the decision and run, reports closing usage and the outcome', () => {
    started();
    handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { turnId: 't1', ts: now }));
    handleHelperChatEvent(chat('usage', { scope: 'turn', coverage: 'main', tokens: { input: 900, cachedInput: 600, cacheWrite: 0, output: 40 } }, { turnId: 't1' }));
    handleHelperChatEvent(chat('turn_ended', { stopReason: 'end_turn', durationMs: 2500, usage: { input: 900, cachedInput: 600, cacheWrite: 0, output: 40 } }, { turnId: 't1', ts: now + 2500 }));
    handleHelperChatEvent(chat('usage', { scope: 'session', coverage: 'inclusive', tokens: { input: 1500, output: 90 } }));
    handleHelperChatEvent(chat('session_ended', { reason: 'idle_timeout' }, { ts: now + 9000 }));

    const samples = events('clubhouse.helper.usage.sample');
    expect(samples.map((s) => s.attrs['clubhouse.helper_usage.kind'])).toEqual(['turn', 'final']);
    expect(samples[0].attrs).toMatchObject({
      'clubhouse.helper_usage.source': 'provider_turn', 'clubhouse.helper_usage.dedup': 'turn_id', 'clubhouse.helper_usage.scope': 'main',
      'clubhouse.helper_usage.completeness': 'complete', 'clubhouse.helper_usage.input_tokens': 900,
      'clubhouse.helper_usage.cached_input_tokens': 600, 'clubhouse.helper_usage.cache_write_tokens': 0, 'clubhouse.helper_usage.output_tokens': 40,
      'clubhouse.helper_decision.known': true, 'clubhouse.helper_usage.turn_duration_ms': 2500,
    });
    // Reasoning was never reported: absent, not zero.
    expect(samples[0].attrs).not.toHaveProperty('clubhouse.helper_usage.reasoning_tokens');
    expect(samples[1].attrs).toMatchObject({ 'clubhouse.helper_usage.source': 'provider_session_cumulative', 'clubhouse.helper_usage.scope': 'inclusive', 'clubhouse.helper_usage.baseline': 'run', 'clubhouse.helper_usage.input_tokens': 1500 });
    expect(samples[0].attrs).not.toHaveProperty('clubhouse.helper_usage.baseline');
    expect(samples[0].attrs['clubhouse.helper_run.id_hash']).toBe(samples[1].attrs['clubhouse.helper_run.id_hash']);
    expect(samples[0].attrs['clubhouse.helper_run.model_hash']).toBeDefined();

    const [outcome] = events('clubhouse.helper.outcome');
    expect(outcome.attrs).toMatchObject({ 'clubhouse.helper_run.outcome': 'completed', 'clubhouse.helper_run.turns': 1, 'clubhouse.helper_run.native_resumed': false, 'clubhouse.helper_run.duration_ms': 9000 });
    expect(outcome.attrs['clubhouse.helper_run.id_hash']).toBe(samples[0].attrs['clubhouse.helper_run.id_hash']);
    for (const e of local) expect(e.opts?.localOnly).toBe(true);
  });

  it('marks the closing total of a resumed native session as lifetime, not this run\'s use', () => {
    started('helper-1', { resumed: true });
    handleHelperChatEvent(chat('usage', { scope: 'session', coverage: 'inclusive', tokens: { input: 80_000, output: 900 } }));
    handleHelperChatEvent(chat('session_ended', { reason: 'idle_timeout' }));
    const [final] = events('clubhouse.helper.usage.sample');
    expect(final.attrs).toMatchObject({ 'clubhouse.helper_usage.kind': 'final', 'clubhouse.helper_usage.baseline': 'lifetime', 'clubhouse.helper_usage.input_tokens': 80_000 });
    expect(events('clubhouse.helper.outcome')[0].attrs['clubhouse.helper_run.native_resumed']).toBe(true);
  });

  it('two idless turns with equal usage are two samples', () => {
    started('helper-1', { driver: 'claude_agent_sdk' });
    for (let i = 0; i < 2; i++) {
      handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }));
      handleHelperChatEvent(chat('turn_ended', { stopReason: 'end_turn', usage: { input: 5, output: 5 } }));
    }
    const samples = events('clubhouse.helper.usage.sample');
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.attrs['clubhouse.helper_usage.dedup'])).toEqual(['none', 'none']);
  });

  it('counts a turn delivered twice once', () => {
    started();
    for (let i = 0; i < 2; i++) {
      handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { turnId: 't1' }));
      handleHelperChatEvent(chat('turn_ended', { stopReason: 'end_turn', usage: { input: 5, output: 1 } }, { turnId: 't1' }));
    }
    expect(events('clubhouse.helper.usage.sample')).toHaveLength(1);
  });

  it('records a turn with no usage as missing, with no token attributes', () => {
    started();
    handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { turnId: 't1' }));
    handleHelperChatEvent(chat('turn_ended', { stopReason: 'end_turn' }, { turnId: 't1' }));
    handleHelperChatEvent(chat('session_ended', { reason: 'stopped' }));
    const [s] = events('clubhouse.helper.usage.sample');
    expect(s.attrs['clubhouse.helper_usage.completeness']).toBe('none');
    expect(Object.keys(s.attrs).filter((k) => k.endsWith('_tokens'))).toEqual([]);
    expect(events('clubhouse.helper.outcome')[0].attrs).toMatchObject({ 'clubhouse.helper_usage.turns_missing': 1, 'clubhouse.helper_run.outcome': 'cancelled' });
  });

  it('records auth, rate limit and exceeded-quota errors seen in the run', () => {
    started();
    handleHelperChatEvent(chat('error', { code: 'auth_required', message: 'secret detail', fatal: false }));
    handleHelperChatEvent(chat('error', { code: 'rate_limited', message: 'x', fatal: false }));
    handleHelperChatEvent(chat('usage', { scope: 'session', limits: [{ window: 'week', status: 'exceeded' }] }));
    handleHelperChatEvent(chat('session_ended', { reason: 'error' }));
    expect(events('clubhouse.helper.outcome')[0].attrs).toMatchObject({
      'clubhouse.helper_run.auth_errors': 1, 'clubhouse.helper_run.rate_limit_errors': 1, 'clubhouse.helper_run.quota_errors': 1, 'clubhouse.helper_run.outcome': 'failed',
    });
    expect(JSON.stringify(local)).not.toContain('secret detail');
  });

  it('measures only helpers a decision was recorded for', () => {
    started('orchestrator-1');
    handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { agentId: 'orchestrator-1', turnId: 'x' }));
    handleHelperChatEvent(chat('turn_ended', { stopReason: 'end_turn', usage: { input: 1, output: 1 } }, { agentId: 'orchestrator-1', turnId: 'x' }));
    expect(local).toEqual([]);
  });

  it('a context clear continues the same run', () => {
    started();
    handleHelperChatEvent(chat('session_started', { driver: 'claude_stream_json', provider: 'claude-code', cwd: '/x', resumed: false, capabilities: {} }, { sessionId: 's2' }));
    handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { sessionId: 's2', turnId: 'a' }));
    handleHelperChatEvent(chat('turn_ended', { stopReason: 'end_turn', usage: { input: 1, output: 1 } }, { sessionId: 's2', turnId: 'a' }));
    handleHelperChatEvent(chat('session_ended', { reason: 'stopped' }, { sessionId: 's2' }));
    expect(new Set(local.map((e) => e.attrs['clubhouse.helper_run.id_hash'])).size).toBe(1);
  });

  it('a wake after a run is a new run of the same decision, with the native resume flagged', () => {
    started();
    handleHelperChatEvent(chat('session_ended', { reason: 'idle_timeout' }));
    started('helper-1', { resumed: true });
    handleHelperChatEvent(chat('session_ended', { reason: 'idle_timeout' }));
    const [first, second] = events('clubhouse.helper.outcome');
    expect(first.attrs['clubhouse.helper_run.id_hash']).not.toBe(second.attrs['clubhouse.helper_run.id_hash']);
    expect(first.attrs['clubhouse.helper_decision.id_hash']).toBe(second.attrs['clubhouse.helper_decision.id_hash']);
    expect(second.attrs['clubhouse.helper_run.native_resumed']).toBe(true);
  });

  it('a fallback to the terminal is not a chat run', () => {
    started();
    handleHelperChatEvent(chat('session_ended', { reason: 'fallback' }));
    expect(local).toEqual([]);
  });

  it('disposal while running waits for the session to end, so final usage is still joined', () => {
    started();
    handleHelperChatEvent(chat('turn_started', { trigger: 'prompt' }, { turnId: 't1' }));
    recordHelperDisposed('helper-1');
    expect(events('clubhouse.helper.outcome')).toEqual([]);
    handleHelperChatEvent(chat('turn_ended', { stopReason: 'cancelled', usage: { input: 8, output: 2 } }, { turnId: 't1' }));
    handleHelperChatEvent(chat('session_ended', { reason: 'stopped' }));
    expect(events('clubhouse.helper.usage.sample')[0].attrs['clubhouse.helper_usage.input_tokens']).toBe(8);
    const [outcome] = events('clubhouse.helper.outcome');
    expect(outcome.attrs).toMatchObject({ 'clubhouse.helper_run.outcome': 'disposed', 'clubhouse.helper_decision.known': true });
    expect(ledger.getEntry('helper-1')).toBeDefined();
  });

  it('disposal of a helper with no open run reports the outcome now', () => {
    recordHelperDisposed('helper-1');
    expect(events('clubhouse.helper.outcome')[0].attrs).toMatchObject({ 'clubhouse.helper_run.outcome': 'disposed', 'clubhouse.helper_decision.known': true });
  });
});

describe('plan-limit samples', () => {
  // Reset times are fixed, as a provider's are, however long the test's clock runs.
  const base = 1_700_000_000_000;
  const view = (over: Partial<QuotaView> = {}): QuotaView => ({
    state: 'known', source: 'cli_query', asOf: new Date(base).toISOString(), limitingWindow: 'weekly',
    weekly: { usedPercent: 40, resetsAt: new Date(base + 86_400_000).toISOString() },
    fiveHour: { usedPercent: 10, resetsAt: new Date(base + 3_600_000).toISOString() },
    ...over,
  });

  it('samples the first reading and labels burn only inside one reset window', () => {
    recordQuotaSample('claude-code', view());
    now += 6 * 60_000;
    recordQuotaSample('claude-code', view({ weekly: { usedPercent: 43, resetsAt: new Date(base + 86_400_000).toISOString() } }));
    const [first, second] = events('clubhouse.helper_quota.sample');
    expect(first.attrs).toMatchObject({ 'clubhouse.helper_quota.trigger': 'first', 'clubhouse.helper_quota.weekly_used_bp': 4000 });
    expect(first.attrs).not.toHaveProperty('clubhouse.helper_quota.weekly_delta_bp');
    expect(second.attrs).toMatchObject({ 'clubhouse.helper_quota.trigger': 'window_change', 'clubhouse.helper_quota.weekly_delta_bp': 300, 'clubhouse.helper_quota.reset_between': false });
  });

  it('claims no burn across a window reset', () => {
    recordQuotaSample('codex-cli', view());
    now += 6 * 60_000;
    recordQuotaSample('codex-cli', view({ state: 'low', weekly: { usedPercent: 2, resetsAt: new Date(base + 8 * 86_400_000).toISOString() } }));
    const second = events('clubhouse.helper_quota.sample')[1];
    expect(second.attrs['clubhouse.helper_quota.reset_between']).toBe(true);
    expect(second.attrs).not.toHaveProperty('clubhouse.helper_quota.weekly_delta_bp');
  });

  it('claims no delta and no reset state when a reset time is missing on either side', () => {
    recordQuotaSample('claude-code', view({ weekly: { usedPercent: 40, resetsAt: null }, fiveHour: { usedPercent: 10, resetsAt: null } }));
    now += 6 * 60_000;
    recordQuotaSample('claude-code', view({ weekly: { usedPercent: 45, resetsAt: null }, fiveHour: { usedPercent: 10, resetsAt: null } }));
    now += 6 * 60_000;
    // Present now, missing before: still no evidence the two readings share a window.
    recordQuotaSample('claude-code', view({ weekly: { usedPercent: 50, resetsAt: new Date(base + 86_400_000).toISOString() } }));
    const samples = events('clubhouse.helper_quota.sample');
    expect(samples).toHaveLength(3);
    for (const s of samples) {
      expect(s.attrs).not.toHaveProperty('clubhouse.helper_quota.weekly_delta_bp');
      expect(s.attrs).not.toHaveProperty('clubhouse.helper_quota.reset_between');
    }
  });

  it('skips an unchanged reading inside the interval and samples it after', () => {
    recordQuotaSample('claude-code', view());
    now += 6 * 60_000;
    recordQuotaSample('claude-code', view());
    expect(events('clubhouse.helper_quota.sample')).toHaveLength(1);
    now += HELPER_TELEMETRY_LIMITS.quotaSampleIntervalMs;
    recordQuotaSample('claude-code', view());
    expect(events('clubhouse.helper_quota.sample')[1].attrs['clubhouse.helper_quota.trigger']).toBe('interval');
  });

  it('samples a state change at once', () => {
    recordQuotaSample('claude-code', view());
    now += 1000;
    recordQuotaSample('claude-code', view({ state: 'near_limit' }));
    expect(events('clubhouse.helper_quota.sample')[1].attrs['clubhouse.helper_quota.trigger']).toBe('state_change');
  });

  it('caps samples per provider per hour', () => {
    let flip = false;
    for (let i = 0; i < 40; i++) {
      now += 1000;
      flip = !flip;
      recordQuotaSample('claude-code', view({ state: flip ? 'known' : 'low' }));
    }
    expect(events('clubhouse.helper_quota.sample')).toHaveLength(HELPER_TELEMETRY_LIMITS.maxQuotaSamplesPerProviderPerHour);
  });

  it('records an unreadable reading as unavailable: no percent', () => {
    recordQuotaSample('copilot-cli', { state: 'unknown', source: 'none', asOf: null, unknownReason: 'not_supported' });
    const [s] = events('clubhouse.helper_quota.sample');
    expect(s.attrs).toMatchObject({ 'clubhouse.helper_quota.state': 'unknown', 'clubhouse.helper_quota.unknown_reason': 'not_supported', 'clubhouse.helper_quota.limiting_window': 'none' });
    expect(Object.keys(s.attrs).filter((k) => k.endsWith('_bp'))).toEqual([]);
    expect(s.opts?.localOnly).toBe(true);
  });
});

describe('budget', () => {
  it('drops past the hourly limit instead of crowding out other signals, and recovers next hour', () => {
    for (let i = 0; i < HELPER_TELEMETRY_LIMITS.maxEventsPerHour + 50; i++) recordHelperReuse({ helperId: `h${i}`, kind: 'wake' });
    expect(local).toHaveLength(HELPER_TELEMETRY_LIMITS.maxEventsPerHour);
    now += 60 * 60_000;
    recordHelperReuse({ helperId: 'later', kind: 'wake' });
    expect(local).toHaveLength(HELPER_TELEMETRY_LIMITS.maxEventsPerHour + 1);
  });
});
