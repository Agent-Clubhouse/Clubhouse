import { setGrantedSkills } from './managed-agents/delivery';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
import { agentRegistry } from './agent-registry';
import { withAgentActivity, withAgentTransition } from './agent-transition';
import { changeAgentProvider, previewAgentProvider, verifyProviderStartPreview } from './agent-provider-control';
const w = vi.hoisted(() => ({ defaults: {} as any, config: {} as any, readFailed: false, beforeAck: undefined as undefined | (() => void), afterWrite: undefined as undefined | (() => void), catalogEfforts: ['high', 'low'] as string[], inventoryReadable: true, available: true, instructions: 'same', runtime: 'terminal', running: false, beforeEffect: undefined as undefined | (() => void), commitFailed: false, revision: 1, captureFailed: false, beforeCommit: undefined as undefined | (() => void), beforeAvailability: undefined as undefined | (() => void) }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ headContent: async (id: string) => ({ entry: { name: id, source: { kind: 'library' }, headRevision: w.revision }, content: id === 'text' ? { kind: 'block', content: 'same' } : { kind: 'mcp', serverKey: 'clubhouse' }, droppedEnvValues: [] }) }) }));
vi.mock('./agent-config', () => ({
  getDurableConfig: async () => { if (w.readFailed) throw new Error('postcommit saved read failed'); return w.config; },
  peekCachedDurableConfig: () => w.config,
  peekDurableConfigsChecked: async () => ({ readable: w.inventoryReadable, agents: [w.config] }),
  flushAgentConfig: async () => {},
  updateDurableConfig: vi.fn(async (_p, _id, update, check, precondition, onPersisted) => { w.beforeCommit?.(); await check?.(); await precondition?.prepare(); w.beforeEffect?.(); precondition?.check(w.config); if (w.commitFailed) throw new Error('disk full'); const changed = (w.config.orchestrator || w.defaults.orchestrator || 'claude-code') !== update.orchestrator; if (changed) { for (const session of w.config.sessionHistory ?? []) session.orchestrator ??= w.config.orchestrator || 'claude-code'; delete w.config.lastSessionId; delete w.config.model; delete w.config.effort; delete w.config.routing; delete w.config.contextWindow; } if (update.model !== undefined) { if ((update.model === 'default' ? undefined : update.model) !== w.config.model) { delete w.config.effort; delete w.config.routing; } if (update.model === 'default') delete w.config.model; else w.config.model = update.model; } if (update.effort !== undefined) { if (update.effort === null) delete w.config.effort; else w.config.effort = update.effort; } if (update.providerTransition) w.config.providerTransition = update.providerTransition; w.config.orchestrator = update.orchestrator; w.beforeAck?.(); onPersisted?.(structuredClone(w.config)); w.afterWrite?.(); }),
}));
vi.mock('./agent-system', () => ({
  resolveOrchestrator: async (_p: string, id = w.defaults.orchestrator || 'claude-code') => ({ id, conventions: { settingsFormat: id === 'codex-cli' ? 'toml' : 'json', legacyInstructionsFile: id === 'codex-cli' ? 'AGENTS.md' : 'CLAUDE.md' }, buildMcpArgs: () => [], peekModels: () => ({ source: 'live', via: 'handshake', fetchedAt: Date.now(), models: [{ id: 'fixture-model', label: 'Fixture', isDefault: true, efforts: w.catalogEfforts }, { id: 'externally-selected-model', label: 'Another valid model', efforts: w.catalogEfforts }] }), listModels: async () => ({ source: 'live', via: 'handshake', fetchedAt: Date.now(), models: [{ id: 'fixture-model', label: 'Fixture', isDefault: true, efforts: w.catalogEfforts }, { id: 'externally-selected-model', label: 'Another valid model', efforts: w.catalogEfforts }] }), getCapabilities: () => ({ permissions: true }), inspectInstructions: async () => id === 'codex-cli' ? w.instructions : 'same' }),
  checkAvailability: async () => { w.beforeAvailability?.(); return { available: w.available }; },
  isAgentRunning: () => w.running, isAgentStopping: () => false,
  waitForAgentStopped: async () => !w.running,
}));
vi.mock('./mobile-agents', () => ({ effectiveOrchestrators: () => [{ id: 'claude-code' }, { id: 'codex-cli' }] }));
vi.mock('./agent-settings-service', () => ({ readProjectAgentDefaults: async () => w.defaults, readLaunchWrapper: async () => undefined }));
vi.mock('./free-agent-settings');
vi.mock('./chat-runtime-settings', () => ({ isChatEnabled: () => true, resolveRuntimeMode: () => ({ mode: w.runtime }) }));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => ({}) }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: vi.fn(() => undefined), getAllRegistrations: () => new Map() } }));
vi.mock('./session-capture-barrier', () => ({ sessionCaptureFor: () => undefined, hasSessionCaptureFailure: () => w.captureFailed, noteSessionCaptureFailure: () => { w.captureFailed = true; } }));
// Choose models yourself (#3191): the Dispatcher's folder, and whether its models are chosen by hand.
const dispatcherModels = vi.hoisted(() => ({ byHand: false }));
vi.mock('./dispatcher/dispatcher-paths', () => ({ isDispatcherPath: (p: string) => p === '/dispatcher' }));
vi.mock('./dispatcher/dispatcher-models', () => ({ modelsChosenByHand: () => dispatcherModels.byHand }));
import { updateDurableConfig } from './agent-config';
const actor = { key: 'phone:paired', assertAuthorized: () => {}, assertCommitAuthorized: () => {} };
const preview = () => previewAgentProvider('/fixture', 'a', 'codex-cli', actor);
beforeEach(() => {
  w.config = { id: 'a', name: 'Agent', orchestrator: 'claude-code', lastSessionId: 'claude-native', sessionHistory: [{ sessionId: 'claude-native', orchestrator: 'claude-code' }], worktreePath: '/fixture/work', orchestration: { control: 'hands-off' }, mcpIds: ['workiq'] };
  w.readFailed = false; w.beforeAck = undefined; w.afterWrite = undefined; w.catalogEfforts = ['high', 'low']; w.inventoryReadable = true; w.beforeEffect = undefined; w.commitFailed = false; w.revision = 1; w.defaults = {}; w.beforeCommit = undefined; w.runtime = 'terminal'; w.captureFailed = false; w.available = true; w.instructions = 'same'; w.running = false; w.beforeAvailability = undefined;
  vi.mocked(updateDurableConfig).mockClear(); vi.mocked(agentRegistry.get).mockReturnValue(undefined);
  dispatcherModels.byHand = false;
});
describe('guided provider control', () => {
  // Independent QA3731 regression, copied with attribution from qa-provider-apply-v2.
  it('QA3731 newly granted skill at Apply mutation must refuse and retain native preparation', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'qa3731-grant-'));
    let granted = false;
    const reset = setGrantedSkills(() => granted ? ['builtin-skill-prepare-handoff'] : []);
    const project = path.join(cwd, '.project');
    await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true });
    try {
      await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), 'same');
      w.config.worktreePath = cwd; w.config.managed = { version: 1, blocks: ['text'], skills: [], mcps: [] };
      await fsp.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config]));
      const selection = { contractVersion: 2 as const };
      const p = await previewAgentProvider(project, 'a', 'codex-cli', actor, undefined, selection);
      expect(p.blocked).toBeNull();
      w.beforeEffect = () => { granted = true; };
      await expect(changeAgentProvider(project, 'a', 'codex-cli', p.expectedState, actor, selection)).rejects.toMatchObject({ code: 'managed_preparation_retained', extra: { transition: { savedUnchanged: true, persisted: false, nativePreparation: 'may_remain' } } });
      expect(w.config.orchestrator).toBe('claude-code');
      expect(existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true);
    } finally { reset(); await fsp.rm(cwd, { recursive: true, force: true }); }
  });

  it('preserves identity/history/policy and writes only provider; never starts', async () => {
    const p = await preview();
    expect(p).toMatchObject({ canSave: true, activeProvider: null, contextTransferred: false, nextStart: 'new_session' });
    const original = structuredClone(w.config);
    expect(await changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).toMatchObject({ status: 'changed', state: 'sleeping' });
    expect(updateDurableConfig).toHaveBeenCalledWith('/fixture', 'a', { orchestrator: 'codex-cli' }, expect.any(Function));
    expect(w.config).toEqual({ ...original, orchestrator: 'codex-cli', lastSessionId: undefined });
  });
  it('previews equivalent managed instructions before generating an absent target (#3731)', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'provider-apply-'));
    try {
      await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), 'same');
      w.config.worktreePath = cwd;
      w.config.managed = { version: 1, blocks: ['text'], skills: [], mcps: [] };
      w.instructions = '';
      const p = await previewAgentProvider('/fixture', 'a', 'codex-cli', actor, undefined, { contractVersion: 2 });
      expect(p).toMatchObject({ canSave: true, instructions: 'equivalent', instructionScope: 'managed_composition' });
      await expect(fsp.stat(path.join(cwd, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await fsp.rm(cwd, { recursive: true, force: true }); }
  });
  it('keeps v1 native preview behavior and does not add a v2 receipt implicitly', async () => {
    w.config.managed = { version: 1, blocks: ['text'], skills: [], mcps: [] }; w.instructions = '';
    const p = await preview();
    expect(p).toMatchObject({ blocked: 'instructions_not_equivalent', instructionScope: 'native_primary_only' });
    expect(p).not.toHaveProperty('contract');
  });
  it('previews explicit next-wake resets and persists chosen model/effort on the same provider', async () => {
    const selection = { contractVersion: 2 as const, model: { kind: 'selected' as const, id: 'fixture-model' }, effort: 'high' };
    const p = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, selection);
    expect(p.contract).toMatchObject({ result: { status: 'preview', persisted: false, started: false }, proposed: { model: { value: 'fixture-model', source: 'agent' }, effort: { value: 'high', source: 'agent' } } });
    const result = await changeAgentProvider('/fixture', 'a', 'claude-code', p.expectedState, actor, selection);
    expect(result.contract).toMatchObject({ saved: p.contract!.proposed, result: { status: 'changed', persisted: true, started: false } });
    expect(w.config.lastSessionId).toBe('claude-native');
    const omitted = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, { contractVersion: 2, model: undefined, effort: undefined });
    expect(omitted.contract!.proposed).toEqual(result.contract!.saved);
    const unchanged = await changeAgentProvider('/fixture', 'a', 'claude-code', omitted.expectedState, actor, { contractVersion: 2 });
    expect(unchanged.contract!.result).toEqual({ status: 'already_selected', persisted: true, started: false });
    const clear = { contractVersion: 2 as const, model: { kind: 'provider_default' as const }, effort: null };
    const c = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, clear);
    expect(c.contract!.proposed).toMatchObject({ model: { value: null, source: 'provider_default' }, effort: { value: null, source: 'provider_default' } });
    expect((await changeAgentProvider('/fixture', 'a', 'claude-code', c.expectedState, actor, clear)).contract!.saved).toEqual(c.contract!.proposed);
  });
  it('binds v2 selection/version/target and defaults into preview authorization', async () => {
    const selection = { contractVersion: 2 as const, model: { kind: 'selected' as const, id: 'fixture-model' }, effort: 'high' };
    const p = await previewAgentProvider('/fixture', 'a', 'codex-cli', actor, undefined, selection);
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor, { ...selection, effort: 'low' })).rejects.toMatchObject({ code: 'stale_state' });
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
    w.defaults = { commandPrefix: 'changed' };
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor, selection)).rejects.toMatchObject({ code: 'stale_state' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('commits managed native preparation and marker together, retaining history/settings and reporting preparation after rejected apply', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'provider-transaction-'));
    const project = path.join(cwd, '.project');
    await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true });
    try {
      await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), 'same');
      w.config.worktreePath = cwd; w.config.managed = { version: 1, blocks: ['text'], skills: [], mcps: [] }; w.instructions = '';
      await fsp.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config]));
      const selection = { contractVersion: 2 as const };
      const p = await previewAgentProvider(project, 'a', 'codex-cli', actor, undefined, selection);
      const original = structuredClone(w.config);
      w.commitFailed = true;
      await expect(changeAgentProvider(project, 'a', 'codex-cli', p.expectedState, actor, selection)).rejects.toMatchObject({ code: 'managed_preparation_retained', extra: { transition: { persisted: false, savedUnchanged: true } } });
      expect(w.config).toEqual(original); expect(existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true);
      await fsp.unlink(path.join(cwd, 'AGENTS.md'));
      w.commitFailed = false;
      // Actor is revoked exactly after the target bytes are prepared.
      const revocable = { key: actor.key, assertAuthorized: () => { if (existsSync(path.join(cwd, 'AGENTS.md'))) throw new Error('revoked'); }, assertCommitAuthorized: () => { if (existsSync(path.join(cwd, 'AGENTS.md'))) throw new Error('revoked'); } };
      await expect(changeAgentProvider(project, 'a', 'codex-cli', p.expectedState, revocable, selection)).rejects.toMatchObject({ code: 'managed_preparation_retained' });
      expect(w.config).toEqual(original); expect(existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true);
      await fsp.unlink(path.join(cwd, 'AGENTS.md'));
      const done = await changeAgentProvider(project, 'a', 'codex-cli', p.expectedState, actor, selection);
      expect(done.contract!.saved).toEqual(done.contract!.proposed);
      expect(done).toMatchObject({ status: 'changed', nextStart: 'new_session' });
      expect(w.config).toMatchObject({ managed: original.managed, sessionHistory: original.sessionHistory, orchestration: original.orchestration,
        providerTransition: { version: 2, agentId: 'a', provider: 'codex-cli', delivery: 'read_only_managed' } });
      expect(await fsp.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('same');
    } finally { await fsp.rm(cwd, { recursive: true, force: true }); }
  });
  it('carries original start evidence and excludes only lastSleep bookkeeping', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'original-provider-witness-'));
    const project = path.join(cwd, '.project'); await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true });
    try {
      await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), 'same');
      w.config.worktreePath = cwd; w.config.runtimeMode = 'terminal'; w.config.managed = { version: 1, blocks: ['text'], skills: [], mcps: [] };
      await fsp.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config]));
      const p = await previewAgentProvider(project, 'a', 'codex-cli', actor, undefined, { contractVersion: 2 });
      await changeAgentProvider(project, 'a', 'codex-cli', p.expectedState, actor, { contractVersion: 2 });
      // Persist the mocked writer's result; agent-config.test covers the real durable writer.
      await fsp.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config]));
      const saved = await previewAgentProvider(project, 'a', 'codex-cli', actor, undefined, { contractVersion: 2 });
      const admission = await verifyProviderStartPreview(project, 'a', 'codex-cli', saved.expectedState, saved.contract!.saved, actor);
      const original = structuredClone(w.config);
      for (const patch of [
        { orchestrator: 'claude-code' }, { model: 'changed' }, { effort: 'low' }, { runtimeMode: 'chat' },
        { access: 'full_access' }, { sandbox: 'danger-full-access' }, { approvalPolicy: 'never' },
        { lastSessionId: 'changed-native' }, { sessionHistory: [] }, { quarantinedSessionIds: ['native'] },
        { managed: { version: 1, blocks: [], skills: [], mcps: [] } },
        { providerTransition: { ...original.providerTransition, nativeFingerprint: 'f'.repeat(64) } },
      ]) {
        w.config = { ...structuredClone(original), ...patch };
        expect(admission.assertBeforeCreate, JSON.stringify(Object.keys(patch))).toThrow('stale_state');
      }
      w.config = structuredClone(original); w.config.lastSleep = { reason: 'user', at: 'changed bookkeeping only' };
      await fsp.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config]));
      expect(admission.assertBeforeCreate).not.toThrow();
      w.catalogEfforts.push('new-valid-offering'); expect(admission.assertBeforeCreate).toThrow('stale_state'); w.catalogEfforts.pop();
      await fsp.writeFile(path.join(project, '.clubhouse', 'settings.json'), JSON.stringify({ agentDefaults: { testCommand: 'new generation with same nullable model/effort' } }));
      expect(admission.assertBeforeCreate).toThrow('stale_state');
    } finally { await fsp.rm(cwd, { recursive: true, force: true }); }
  });
  it('refuses a newly shared workspace at the actual Apply mutation boundary', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'provider-isolation-'));
    const project = path.join(cwd, '.project'); await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true });
    try {
      await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), 'same');
      w.config.worktreePath = cwd; w.config.managed = { version: 1, blocks: ['text'], skills: [], mcps: [] };
      await fsp.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config]));
      const p = await previewAgentProvider(project, 'a', 'codex-cli', actor, undefined, { contractVersion: 2 });
      const original = structuredClone(w.config);
      w.beforeEffect = () => writeFileSync(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config, { ...w.config, id: 'new-peer' }]));
      await expect(changeAgentProvider(project, 'a', 'codex-cli', p.expectedState, actor, { contractVersion: 2 })).rejects.toMatchObject({ code: 'managed_preparation_retained', extra: { transition: { savedUnchanged: true, persisted: false, nativePreparation: 'may_remain' } } });
      expect(w.config).toEqual(original); expect(await fsp.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('same');
    } finally { await fsp.rm(cwd, { recursive: true, force: true }); }
  });
  it('preserves verified Apply acknowledgment when the postcommit saved read fails', async () => {
    const selection = { contractVersion: 2 as const, model: { kind: 'selected' as const, id: 'fixture-model' }, effort: 'high' };
    const p = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, selection);
    w.afterWrite = () => { w.readFailed = true; };
    await expect(changeAgentProvider('/fixture', 'a', 'claude-code', p.expectedState, actor, selection)).resolves.toMatchObject({ status: 'changed',
      contract: { saved: { model: { value: 'fixture-model', source: 'agent' }, effort: { value: 'high', source: 'agent' } }, result: { persisted: true, started: false } },
      nextWake: { state: 'blocked', code: 'next_wake_unverified' } });
    expect(w.config.model).toBe('fixture-model');
  });
  it.each(['claude-code', undefined])('refuses to label an acknowledged provider %s with the requested provider', async (acknowledgedProvider) => {
    w.config.orchestrator = 'codex-cli';
    const selection = { contractVersion: 2 as const, model: { kind: 'selected' as const, id: 'fixture-model' }, effort: 'high' };
    const p = await previewAgentProvider('/fixture', 'a', 'codex-cli', actor, undefined, selection);
    w.beforeAck = () => { if (acknowledgedProvider) w.config.orchestrator = acknowledgedProvider; else delete w.config.orchestrator; };
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor, selection)).rejects.toMatchObject({ code: 'apply_committed_state_conflict', extra: { transition: { status: 'committed_state_conflict', persisted: true, requestedSelectionSaved: false, savedProvider: acknowledgedProvider ?? null, nextWake: 'fresh_read_and_review_required' } } });
  });
  it.each([
    { name: 'model value', original: { model: 'fixture-model', effort: 'low' }, selection: { model: { kind: 'selected', id: 'fixture-model' }, effort: 'high' }, ack: { model: 'externally-selected-model' } },
    { name: 'model source', original: { model: 'fixture-model', effort: 'low' }, selection: { model: { kind: 'selected', id: 'fixture-model' }, effort: 'high' }, ack: { model: undefined } },
    { name: 'effort value', original: { model: 'fixture-model', effort: 'high' }, selection: { model: { kind: 'selected', id: 'fixture-model' }, effort: 'high' }, ack: { effort: 'low' } },
    { name: 'effort source', original: { model: 'fixture-model', effort: 'high' }, selection: { model: { kind: 'selected', id: 'fixture-model' }, effort: 'high' }, ack: { effort: undefined } },
    { name: 'context reset', original: {}, selection: { model: { kind: 'provider_default' }, effort: null }, ack: { contextWindow: 'external-context' } },
    { name: 'routing reset', original: { model: 'old-model', routing: { reason: 'old' } }, selection: { model: { kind: 'selected', id: 'fixture-model' }, effort: 'high' }, ack: { routing: { reason: 'external' } } },
    { name: 'resume pointer preservation', original: {}, selection: { model: { kind: 'provider_default' }, effort: null }, ack: { lastSessionId: 'external-native' } },
    { name: 'history retention', original: {}, selection: { model: { kind: 'selected', id: 'fixture-model' }, effort: 'high' }, ack: { sessionHistory: [] } },
  ])('refuses acknowledged lost reviewed $name intent', async ({ original, selection, ack }) => {
    Object.assign(w.config, original);
    w.config.orchestrator = 'codex-cli';
    const chosen = { ...selection, contractVersion: 2 } as any;
    const p = await previewAgentProvider('/fixture', 'a', 'codex-cli', actor, undefined, chosen);
    w.beforeAck = () => { for (const [key, value] of Object.entries(ack)) { if (value === undefined) delete w.config[key]; else w.config[key] = value; } };
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor, chosen)).rejects.toMatchObject({ code: 'apply_committed_state_conflict', extra: { transition: { persisted: true, requestedSelectionSaved: false, nextWake: 'fresh_read_and_review_required' } } });
  });
  it('previews the actual reset of legacy stored default model effort and routing', async () => {
    w.config.model = 'default'; w.config.effort = 'high'; w.config.routing = { reason: 'legacy-default' };
    const chosen = { contractVersion: 2 as const, model: { kind: 'provider_default' as const } };
    const p = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, chosen);
    expect(p.contract!.proposed.effort).toEqual({ value: null, source: 'provider_default' });
    expect(p.settingsReset).toEqual(expect.arrayContaining(['model', 'effort', 'routing']));
    const result = await changeAgentProvider('/fixture', 'a', 'claude-code', p.expectedState, actor, chosen);
    expect(result.contract!.saved).toEqual(p.contract!.proposed);
  });
  it('preserves legacy stored default when selection is omitted', async () => {
    w.config.model = 'default'; w.config.effort = 'high'; w.config.routing = { reason: 'legacy-default' };
    const before = structuredClone(w.config); const chosen = { contractVersion: 2 as const };
    const p = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, chosen);
    expect(p.blocked).toBeNull(); expect(p.settingsReset).toEqual([]);
    expect(p.contract!.proposed).toEqual(p.contract!.saved);
    expect(await changeAgentProvider('/fixture', 'a', 'claude-code', p.expectedState, actor, chosen)).toMatchObject({ status: 'already_selected' });
    expect(w.config).toEqual(before); expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('does not grandfather an unsupported concrete model, new effort or explicit selected default', async () => {
    w.config.model = 'not-in-current-catalog';
    expect((await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, { contractVersion: 2 })).blocked).toBe('model_not_offered');
    w.config.model = 'default'; w.catalogEfforts = ['low'];
    expect((await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, { contractVersion: 2, effort: 'high' })).blocked).toBe('effort_not_offered');
    await expect(previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, { contractVersion: 2, model: { kind: 'selected', id: 'default' } })).rejects.toMatchObject({ code: 'invalid_selection' });
    expect(w.config.model).toBe('default'); expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('keeps an explicitly selected effort after the legacy default-model reset', async () => {
    w.config.model = 'default'; w.config.effort = 'high'; w.config.routing = { reason: 'legacy-default' };
    const chosen = { contractVersion: 2 as const, model: { kind: 'provider_default' as const }, effort: 'high' };
    const p = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, chosen);
    expect(p.contract!.proposed.effort).toEqual({ value: 'high', source: 'agent' }); expect(p.settingsReset).toContain('routing');
    const result = await changeAgentProvider('/fixture', 'a', 'claude-code', p.expectedState, actor, chosen);
    expect(result.contract!.saved).toEqual(p.contract!.proposed); expect(w.config.model).toBeUndefined(); expect(w.config.effort).toBe('high');
  });
  it('accepts equal normalized provider-default semantics in an acknowledged snapshot', async () => {
    w.config.orchestrator = 'codex-cli'; w.config.model = 'fixture-model';
    const chosen = { contractVersion: 2 as const, model: { kind: 'provider_default' as const }, effort: null };
    const p = await previewAgentProvider('/fixture', 'a', 'codex-cli', actor, undefined, chosen);
    w.beforeAck = () => { w.config.model = 'default'; };
    const result = await changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor, chosen);
    expect(result.contract).toMatchObject({ saved: p.contract!.proposed, result: { persisted: true } });
  });
  it.each([
    ['lastSessionId', 'external-native', 'resumePointer'], ['contextWindow', 'external-context', 'contextWindow'],
    ['routing', { reason: 'external' }, 'routing'], ['sessionHistory', [], 'history'],
    ['providerTransition', undefined, 'managedTransition'],
  ])('refuses acknowledged managed %s reset/retention drift after preparing native instructions', async (key, value, conflict) => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'reviewed-reset-'));
    const project = path.join(cwd, '.project'); await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true });
    try {
      await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), 'same');
      w.config.worktreePath = cwd; w.config.runtimeMode = 'terminal'; w.config.model = 'old-model'; w.config.effort = 'low';
      w.config.contextWindow = 'old-context'; w.config.routing = { reason: 'old' };
      w.config.managed = { version: 1, blocks: ['text'], skills: [], mcps: [] };
      await fsp.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config]));
      const chosen = { contractVersion: 2 as const };
      const p = await previewAgentProvider(project, 'a', 'codex-cli', actor, undefined, chosen);
      expect(p.settingsReset).toEqual(expect.arrayContaining(['model', 'effort', 'contextWindow', 'routing', 'resumePointer']));
      w.beforeAck = () => { if (value === undefined) delete w.config[key as string]; else w.config[key as string] = value; };
      await expect(changeAgentProvider(project, 'a', 'codex-cli', p.expectedState, actor, chosen)).rejects.toMatchObject({ code: 'apply_committed_state_conflict', extra: { transition: { persisted: true, conflicts: expect.arrayContaining([conflict]), nextWake: 'fresh_read_and_review_required' } } });
      expect(w.config.orchestrator).toBe('codex-cli'); expect(await fsp.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('same');
    } finally { await fsp.rm(cwd, { recursive: true, force: true }); }
  });
  it.each([false, true])('previews inherited same-provider managed=%s no-op versus required marker write', async (managed) => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'inherited-provider-'));
    const project = path.join(cwd, '.project'); await fsp.mkdir(path.join(project, '.clubhouse'), { recursive: true });
    try {
      await fsp.writeFile(path.join(cwd, 'AGENTS.md'), 'same');
      delete w.config.orchestrator; delete w.config.lastSessionId;
      w.defaults = { orchestrator: 'codex-cli' }; w.config.worktreePath = cwd; w.config.runtimeMode = 'terminal'; w.config.model = 'fixture-model';
      if (managed) w.config.managed = { version: 1, blocks: ['text'], skills: [], mcps: [] };
      await fsp.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([w.config]));
      const chosen = { contractVersion: 2 as const };
      const p = await previewAgentProvider(project, 'a', 'codex-cli', actor, undefined, chosen);
      expect(p.contract).toMatchObject({ current: { provider: 'codex-cli', providerOverride: null }, proposed: { providerOverride: managed ? 'codex-cli' : null } });
      const result = await changeAgentProvider(project, 'a', 'codex-cli', p.expectedState, actor, chosen);
      expect(result.status).toBe(managed ? 'changed' : 'already_selected');
      expect(result.contract!.saved).toEqual(p.contract!.proposed);
      expect(w.config.model).toBe('fixture-model');
      if (!managed) expect(updateDurableConfig).not.toHaveBeenCalled();
    } finally { await fsp.rm(cwd, { recursive: true, force: true }); }
  });
  it('retains the committed snapshot when settings change after acknowledgment and issues no wake token', async () => {
    const selection = { contractVersion: 2 as const, model: { kind: 'selected' as const, id: 'fixture-model' }, effort: 'high' };
    const p = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, selection);
    w.afterWrite = () => { w.config.effort = 'low'; };
    const result = await changeAgentProvider('/fixture', 'a', 'claude-code', p.expectedState, actor, selection);
    expect(result).toMatchObject({ status: 'changed', contract: { saved: { effort: { value: 'high', source: 'agent' } }, result: { persisted: true } }, nextWake: { state: 'blocked', code: 'stale_state' } });
    expect(result.nextWake).not.toHaveProperty('expectedState');
    expect(w.config.effort).toBe('low');
  });
  it('does not turn a post-acknowledgment observer failure into a failed save', async () => {
    const selection = { contractVersion: 2 as const, effort: 'high' };
    const p = await previewAgentProvider('/fixture', 'a', 'claude-code', actor, undefined, selection);
    w.afterWrite = () => { throw new Error('observer failed'); };
    await expect(changeAgentProvider('/fixture', 'a', 'claude-code', p.expectedState, actor, selection)).resolves.toMatchObject({ status: 'changed', contract: { result: { persisted: true, started: false } }, nextWake: { state: 'blocked', code: 'next_wake_unverified' } });
  });
  it('rechecks authorization at the synchronous configuration mutation boundary', async () => {
    let revoked = false;
    const caller = { ...actor, assertCommitAuthorized: () => { if (revoked) throw new Error('revoked at effect'); } };
    const selection = { contractVersion: 2 as const, model: { kind: 'selected' as const, id: 'fixture-model' }, effort: 'high' };
    const p = await previewAgentProvider('/fixture', 'a', 'claude-code', caller, undefined, selection);
    w.beforeEffect = () => { revoked = true; };
    await expect(changeAgentProvider('/fixture', 'a', 'claude-code', p.expectedState, caller, selection)).rejects.toThrow('revoked at effect');
    expect(w.config).toMatchObject({ orchestrator: 'claude-code', lastSessionId: 'claude-native' });
    expect(w.config.model).toBeUndefined();
  });
  it('rejects stale configuration and a token belonging to another caller', async () => {
    const p = await preview(); w.config.model = 'changed';
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
    delete w.config.model;
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, { ...actor, key: 'phone:other' })).rejects.toMatchObject({ code: 'stale_state' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('refuses unavailable provider, instruction mismatch and a live agent', async () => {
    w.available = false; expect(await preview()).toMatchObject({ canSave: false, blocked: 'orchestrator_unavailable' });
    w.available = true; w.instructions = 'different'; expect(await preview()).toMatchObject({ blocked: 'instructions_not_equivalent' });
    w.instructions = 'same'; w.running = true; expect(await preview()).toMatchObject({ blocked: 'agent_running' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('blocks a plain agent on the project\'s legacy permission rules, never a managed one (#3245)', async () => {
    w.defaults = { permissions: { allow: ['Bash(git:*)'] } };
    expect(await preview()).toMatchObject({ canSave: false, blocked: 'incompatible_permissions' });
    w.config.managed = { version: 1, blocks: [], skills: [], mcps: [] };
    expect(await preview()).toMatchObject({ canSave: true, blocked: null });
  });
  it('blocks saving after a failed capture even though the process has stopped', async () => {
    w.captureFailed = true;
    const p = await preview();
    expect(p).toMatchObject({ state: 'sleeping', canSave: false, blocked: 'session_capture_failed' });
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'session_capture_failed' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('rechecks authorization after async capability checks', async () => {
    let revoked = false;
    w.beforeAvailability = () => { revoked = true; };
    await expect(previewAgentProvider('/fixture', 'a', 'codex-cli', { key: 'phone', assertAuthorized: () => { if (revoked) throw new Error('revoked'); } })).rejects.toThrow('revoked');
  });
  it('rechecks runtime after config preflight, immediately before mutation', async () => {
    const p = await preview();
    w.beforeCommit = () => { w.runtime = 'chat'; };
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
    expect(w.config.orchestrator).toBe('claude-code');
  });
  it('rejects a preview after the target runtime changes', async () => {
    const p = await preview(); w.runtime = 'chat';
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
    expect(updateDurableConfig).not.toHaveBeenCalled();
  });
  it('detects an intervening lifecycle even if the saved config did not change', async () => {
    const p = await preview(); await withAgentActivity('a', async () => {});
    await expect(changeAgentProvider('/fixture', 'a', 'codex-cli', p.expectedState, actor)).rejects.toMatchObject({ code: 'stale_state' });
  });
});
describe('transition reservation', () => {
  it('refuses a competing start/write until the reservation finishes', async () => {
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const active = withAgentTransition('b', async () => { entered(); await new Promise<void>((r) => { release = r; }); });
    await ready;
    await expect(withAgentActivity('b', async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
    release(); await active;
    await expect(withAgentActivity('b', async () => 'ok')).resolves.toBe('ok');
  });
  it('refuses a transition while an earlier write/start is in flight', async () => {
    let release!: () => void;
    const active = withAgentActivity('c', () => new Promise<void>((r) => { release = r; }));
    await expect(withAgentTransition('c', async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
    release(); await active;
  });
  it('refuses the Dispatcher while its models are chosen by hand, pointing to Settings, and writes nothing (QA L1)', async () => {
    dispatcherModels.byHand = true;
    for (const call of [
      () => previewAgentProvider('/dispatcher', 'a', 'codex-cli', actor),
      () => changeAgentProvider('/dispatcher', 'a', 'codex-cli', 'any', actor),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'dispatcher_models_by_hand', detail: expect.stringContaining('Settings > Dispatcher') });
    }
    expect(updateDurableConfig).not.toHaveBeenCalled();
    // Any other agent, or the Dispatcher with the switch off, previews as before.
    expect(await preview()).toMatchObject({ canSave: true });
    dispatcherModels.byHand = false;
    expect(await previewAgentProvider('/dispatcher', 'a', 'codex-cli', actor)).toMatchObject({ canSave: true });
  });
});
