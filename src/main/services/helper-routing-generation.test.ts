import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const W = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => W.dir } }));
vi.mock('./log-service', () => ({ appLog: () => undefined }));
vi.mock('../orchestrators', () => {
  const provider = {
    id: 'copilot-cli',
    checkAvailability: async () => ({ available: true }),
    listModels: async () => ({
      source: 'live', via: 'handshake', fetchedAt: Date.now(),
      models: ['gpt-6.1-sol', 'gpt-6.1-terra'].map((id) => ({ id, label: id, efforts: ['high', 'xhigh'] })),
    }),
  };
  return { getProvider: (id: string) => id === provider.id ? provider : undefined, getAllProviders: () => [provider] };
});
vi.mock('./orchestrator-settings', () => ({ getSettings: () => ({ enabled: ['copilot-cli'] }) }));
vi.mock('./agent-settings-service', () => ({ readProjectAgentDefaults: async () => ({}), updateProjectAgentDefaults: async () => ({}) }));
vi.mock('./settings-audit', () => ({ appendSettingsAudit: async () => true }));
vi.mock('../telemetry/feature-events', () => ({ helperPresetsChanged: () => undefined }));
vi.mock('../telemetry/persist', () => ({ persist: { timed: (_key: string, fn: () => unknown) => fn(), recovery: () => undefined } }));
vi.mock('./helper-model-catalog', () => ({
  observeHelperModelCatalog: async () => undefined,
  peekHelperCalibrationModel: (_provider: string, model: string) => ({ model, reason: 'cached_catalog' }),
}));
vi.mock('./provider-quota', () => {
  const quota = { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null };
  return {
    readProviderQuota: async () => quota, peekProviderQuota: () => quota,
    isProviderCoolingDown: async () => false, isProviderCoolingDownNow: () => false,
  };
});

import { decideAutoPlan, planHelperStart, readHelperAuto, type StartPlanRequest } from './helper-routing';
import { _resetHelperAutoStateForTesting, reservedLoad, settleAutoDecision } from './helper-auto-state';
import { ensurePresetCellGenerations, getAutoHelpers, getCopilotAuto, getGlobalHelperCap, getPresetCellGeneration, getPresets, getPresetsRevision, saveAutoHelpers, saveCopilotAuto, savePresets, saveSettings } from './orchestration-settings';
import { resetAllSettingsStoresForTests } from './settings-store';
import { checkHelperLimit } from '../../shared/orchestration-policy';

function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const request: StartPlanRequest = {
  cli: 'auto', difficulty: 'hard', projectPath: '/fixture',
  auto: { effective: true, source: 'app', scopes: { app: { value: true, editable: true } } },
};
const load = () => reservedLoad({ live: new Set(), notRunning: new Set() });
let file: string;

beforeEach(() => {
  W.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-generation-race-'));
  resetAllSettingsStoresForTests();
  _resetHelperAutoStateForTesting();
  file = path.join(W.dir, 'orchestration-settings.json');
  fs.writeFileSync(file, JSON.stringify({
    globalHelperCap: 20, autoHelpers: true,
    helperPresets: { 'copilot-cli': { hard: { model: 'gpt-6.1-sol', effort: 'xhigh' } } },
  }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetHelperAutoStateForTesting();
  resetAllSettingsStoresForTests();
  fs.rmSync(W.dir, { recursive: true, force: true });
});

describe('Auto with real generation persistence', () => {
  it('releases failed pending restrictions without publishing attempted settings or leaving starts blocked', async () => {
    await ensurePresetCellGenerations();
    const generation = getPresetCellGeneration('copilot-cli', 'hard');
    const failure = vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('synthetic restrictive write failure'));
    const writes = [saveCopilotAuto(false), saveAutoHelpers(false), saveSettings({ globalHelperCap: 1 })];
    expect([getCopilotAuto(), getAutoHelpers(), getGlobalHelperCap()]).toEqual([false, false, 1]);
    const results = await Promise.allSettled(writes);
    failure.mockRestore();
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect([getCopilotAuto(), getAutoHelpers(), getGlobalHelperCap()]).toEqual([true, true, 20]);
    expect(getPresetCellGeneration('copilot-cli', 'hard')).toBe(generation);
    const prepared = await planHelperStart(request);
    if (!prepared.ok || !prepared.plan) throw new Error('Expected a prepared Auto start');
    const result = decideAutoPlan(prepared.plan, {});
    expect(result).toMatchObject({ ok: true, plan: { provider: 'copilot-cli', model: 'gpt-6.1-sol' } });
    if (!result.ok) throw new Error(result.message);
    settleAutoDecision(result.plan!.decision!.decisionId);
    expect(load()).toEqual({});
  });

  it.each(['metadata', 'mapping'].flatMap((write) => ['copilot', 'auto', 'cap'].flatMap((restriction) =>
    ['committed', 'failed'].map((outcome) => ({ write, restriction, outcome })))))(
    'honors pending $restriction restrictions at start gates throughout a paused $write write ($outcome)',
    async ({ write, restriction, outcome }) => {
      let prepared: Awaited<ReturnType<typeof planHelperStart>>;
      if (write === 'metadata') {
        const failed = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('synthetic initialization failure'));
        prepared = await planHelperStart(request);
        failed.mockRestore();
        if (!prepared.ok || !prepared.plan) throw new Error('Expected a cold prepared Auto start');
      } else {
        await ensurePresetCellGenerations();
        prepared = await planHelperStart(request);
      }
      const entered = barrier(), release = barrier(), restricted = barrier(), releaseRestriction = barrier();
      const rename = fs.promises.rename;
      let writes = 0;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (to === file && ++writes === 1) {
          entered.release();
          await release.promise;
          if (outcome === 'failed') throw new Error('synthetic preceding rename failure');
        } else if (to === file && writes === 2) {
          restricted.release();
          await releaseRestriction.promise;
        }
        return rename(from, to);
      });
      const writing = (write === 'metadata' ? ensurePresetCellGenerations()
        : savePresets({ 'copilot-cli': { hard: { model: 'gpt-6.1-terra', effort: 'high' } } }))
        .then(() => 'committed', (error: unknown) => error);
      await entered.promise;
      const restricting = restriction === 'copilot' ? saveCopilotAuto(false)
        : restriction === 'auto' ? saveAutoHelpers(false) : saveSettings({ globalHelperCap: 1 });
      const assertRestricted = async (): Promise<void> => {
        if (restriction === 'copilot') {
          expect(getCopilotAuto()).toBe(false);
          // A pre-lock plan may have been prepared before the user's opt-out.
          if (!prepared.ok || !prepared.plan) throw new Error('Expected a prepared Auto start');
          const decision = decideAutoPlan(prepared.plan, {});
          if (decision.ok && decision.plan?.decision) settleAutoDecision(decision.plan.decision.decisionId);
          expect(decision).toMatchObject({ ok: false });
        } else if (restriction === 'auto') {
          const auto = await readHelperAuto({ projectPath: request.projectPath });
          expect(auto).toMatchObject({ effective: false });
          expect(await planHelperStart({ ...request, auto })).toMatchObject({ ok: false, code: 'auto_off' });
        } else {
          expect(checkHelperLimit({ helperCount: 0, totalHelperCount: 1, maxHelpers: 10, globalCap: getGlobalHelperCap() }))
            .toMatchObject({ ok: false, reason: 'global-cap' });
        }
        expect(load()).toEqual({});
      };
      try {
        await assertRestricted();
        release.release();
        await writing;
        await restricted.promise;
        await assertRestricted();
      } finally {
        release.release();
        releaseRestriction.release();
        await Promise.all([writing, restricting]);
      }
      if (outcome === 'failed') expect(await writing).toBeInstanceOf(Error);
      else expect(await writing).toBe('committed');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(saved.helperPresets['copilot-cli'].hard.model).toBe(write === 'mapping' && outcome === 'committed' ? 'gpt-6.1-terra' : 'gpt-6.1-sol');
      if (write === 'metadata' && outcome === 'failed') expect(saved.helperPresetCellGenerations?.['copilot-cli']?.hard).toBeUndefined();
      else expect(saved.helperPresetCellGenerations['copilot-cli'].hard).toBeDefined();
      if (restriction === 'copilot') expect(saved.copilotAuto).toBe(false);
      else if (restriction === 'auto') expect(saved.autoHelpers).toBe(false);
      else expect(saved.globalHelperCap).toBe(1);
    },
  );

  it.each(['committed', 'failed'])('never exposes an ordinary mapping write before its rename is %s', async (outcome) => {
    await ensurePresetCellGenerations();
    const generation = getPresetCellGeneration('copilot-cli', 'hard');
    const entered = barrier(), release = barrier();
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === file) {
        entered.release();
        await release.promise;
        if (outcome === 'failed') throw new Error('synthetic mapping rename failure');
      }
      return rename(from, to);
    });
    const writing = savePresets({ 'copilot-cli': { hard: { model: 'gpt-6.1-terra', effort: 'high' } } })
      .then(() => 'committed', (error: unknown) => error);
    await entered.promise;
    const pendingCell = getPresets()['copilot-cli']?.hard;
    const pendingGeneration = getPresetCellGeneration('copilot-cli', 'hard');
    const pendingRevision = getPresetsRevision();
    let result: ReturnType<typeof decideAutoPlan>;
    try {
      const prepared = await planHelperStart(request);
      if (!prepared.ok || !prepared.plan) throw new Error('Expected a prepared Auto start');
      result = decideAutoPlan(prepared.plan, {});
      if (result.ok) settleAutoDecision(result.plan!.decision!.decisionId);
    } finally {
      release.release();
      await writing;
    }
    expect(load()).toEqual({});
    expect(pendingCell).toEqual({ model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(pendingGeneration).toBe(generation);
    expect(pendingRevision).toBe(0);
    expect(result).toMatchObject({
      ok: true, plan: {
        provider: 'copilot-cli', model: 'gpt-6.1-sol', effort: 'xhigh',
        decision: { calibration: { revision: generation, model: 'gpt-6.1-sol' } },
      },
    });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const prepared = await planHelperStart(request);
    if (!prepared.ok || !prepared.plan) throw new Error('Expected a prepared Auto start');
    const fresh = decideAutoPlan(prepared.plan, {});
    expect(fresh).toMatchObject({ ok: true, plan: {
      model: saved.helperPresets['copilot-cli'].hard.model,
      effort: saved.helperPresets['copilot-cli'].hard.effort,
      decision: { calibration: { revision: saved.helperPresetCellGenerations['copilot-cli'].hard } },
    } });
    if (!fresh.ok) throw new Error(fresh.message);
    settleAutoDecision(fresh.plan!.decision!.decisionId);
    expect(load()).toEqual({});
    if (outcome === 'failed') expect(await writing).toBeInstanceOf(Error);
    else expect(await writing).toBe('committed');
  });

  it('keeps concurrent Copilot-only starts usable and cold when their shared initialization rename fails', async () => {
    const entered = barrier(), release = barrier();
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === file) {
        entered.release();
        await release.promise;
        throw new Error('synthetic generation rename failure');
      }
      return rename(from, to);
    });
    const first = planHelperStart(request);
    await entered.promise;
    let secondPrepared = false;
    const second = planHelperStart(request).then((result) => { secondPrepared = true; return result; });
    let pendingBeforeFailure: boolean;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      pendingBeforeFailure = !secondPrepared;
    } finally {
      release.release();
    }
    const prepared = await Promise.all([first, second]);
    expect(load()).toEqual({});
    const decisions = prepared.map((result) => {
      if (!result.ok || !result.plan) throw new Error('Expected a prepared Auto start');
      return decideAutoPlan(result.plan, {});
    });
    expect(decisions).toEqual([
      expect.objectContaining({ ok: true, plan: expect.objectContaining({ provider: 'copilot-cli', model: 'gpt-6.1-sol', effort: 'xhigh' }) }),
      expect.objectContaining({ ok: true, plan: expect.objectContaining({ provider: 'copilot-cli', model: 'gpt-6.1-sol', effort: 'xhigh' }) }),
    ]);
    expect(pendingBeforeFailure).toBe(true);
    expect(load()).toEqual({ 'copilot-cli': 2 });
    for (const result of decisions) {
      if (!result.ok) throw new Error('Expected a chosen Auto start');
      expect(result.plan?.decision?.calibrationIdentityReason).toBe('missing_generation');
      expect(result.plan?.decision).not.toHaveProperty('calibration');
      settleAutoDecision(result.plan!.decision!.decisionId);
    }
    expect(load()).toEqual({});
    expect(getPresetCellGeneration('copilot-cli', 'hard')).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('helperPresetCellGenerations');
  });

  it('keeps an unchanged cold preparation usable if a later metadata-only retry succeeds', async () => {
    const failure = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('synthetic generation rename failure'));
    const prepared = await planHelperStart(request);
    failure.mockRestore();
    expect(getPresetCellGeneration('copilot-cli', 'hard')).toBeUndefined();
    await ensurePresetCellGenerations();
    expect(getPresetCellGeneration('copilot-cli', 'hard')).toBeDefined();
    if (!prepared.ok || !prepared.plan) throw new Error('Expected a prepared Auto start');
    const result = decideAutoPlan(prepared.plan, {});
    expect(result).toMatchObject({ ok: true, plan: { provider: 'copilot-cli', model: 'gpt-6.1-sol', effort: 'xhigh' } });
    if (!result.ok) throw new Error('Expected a chosen Auto start');
    expect(result.plan?.decision).not.toHaveProperty('calibration');
    expect(load()).toEqual({ 'copilot-cli': 1 });
    settleAutoDecision(result.plan!.decision!.decisionId);
    expect(load()).toEqual({});
  });
});
