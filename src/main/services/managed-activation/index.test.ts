import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
const W = vi.hoisted(() => ({ home: '', binary: '', config: null as DurableAgentConfig | null,
  // Supported fixture has preexisting user choices. Activation never saves these settings.
  hooks: false, mcp: false, runtime: 'terminal', wrapper: undefined as unknown,
  execute: vi.fn(), settingsSave: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.home } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-config', () => ({ peekDurableConfigs: async () => W.config ? [W.config] : [] }));
vi.mock('../agent-registry', () => ({ agentRegistry: { getAllRegistrations: () => new Map() }, resolveOrchestrator: async () => ({ id: W.config?.orchestrator, getBinaryPath: () => W.binary }) }));
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: () => ({ mode: W.runtime }) }));
vi.mock('../orchestrator-settings', () => ({ isHookServerEnabled: () => W.hooks, saveSettings: W.settingsSave }));
vi.mock('../mcp-settings', () => ({ isMcpEnabled: () => W.mcp, saveSettings: W.settingsSave }));
vi.mock('../agent-settings-service', () => ({ readLaunchWrapper: async () => W.wrapper, readProjectAgentDefaults: async () => ({}) }));
vi.mock('child_process', () => ({ execFile: (...args: unknown[]) => W.execute(...args) }));
import { createAssetCatalogStore } from '../asset-catalog/store';
import { emptyComposition } from '../asset-catalog/planner';
import { adoptManagedActivation, previewManagedActivation, withManagedActivationLaunch, readManagedActivation } from './index';
import { withAgentActivity } from '../agent-transition';
import type { BaseAdoption } from '../../../shared/asset-catalog-types';
const platform = process.platform;
const adoption: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'accepted' } };
let projectPath: string; let workspacePath: string;
beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  W.home = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-entry-'));
  projectPath = path.join(W.home, 'project'); workspacePath = path.join(projectPath, '.clubhouse/agents/agent');
  await fs.mkdir(workspacePath, { recursive: true });
  W.binary = path.join(W.home, 'fake-claude-A'); await fs.writeFile(W.binary, 'fake binary A');
  W.config = { id: 'agent-1', name: 'agent', worktreePath: workspacePath, orchestrator: 'claude-code', model: 'sonnet', lastSessionId: 'untouched-session', runtimeMode: 'terminal' } as DurableAgentConfig;
  W.hooks = false; W.mcp = false; W.runtime = 'terminal'; W.wrapper = undefined;
  W.execute.mockImplementation((_binary: string, args: string[], _options: unknown, callback: (error: unknown, stdout: string) => void) => callback(null, args[0] === '--version' ? '2.1.316 (Claude Code)' : '  --append-system-prompt-file <path>\n  --plugin-dir <path>'));
  const catalog = createAssetCatalogStore({ dir: path.join(W.home, '.clubhouse-dev', 'asset-catalog') });
  const block = await catalog.createAsset({ kind: 'block', name: 'Identity', owner: { kind: 'agent', agentId: 'agent-1' }, payload: { content: 'literal @@AgentName' } });
  const composition = { ...emptyComposition(), entries: [{ localId: 'identity', source: { kind: 'local' as const, blockId: block.id } }] };
  const plan = await catalog.plan({ agentId: 'agent-1', adoption, draft: composition });
  await catalog.saveComposition({ agentId: 'agent-1', adoption, composition, expectedRevision: 0, previewFingerprint: plan.fingerprint });
});
afterEach(async () => { Object.defineProperty(process, 'platform', { value: platform }); await fs.rm(W.home, { recursive: true, force: true }); });
const preview = () => previewManagedActivation({ projectPath, agentId: 'agent-1', adoption, expectedRevision: 0 });
const params = () => ({ projectPath, agentId: 'agent-1', cwd: workspacePath, kind: 'durable' as const, orchestrator: 'claude-code' as const });

describe('guarded production activation entry points with fake CLI flag evidence', () => {
  it('positively prepares/adopts/stages/observes a fresh mocked terminal start without changing protected config', async () => {
    const before = JSON.stringify(W.config);
    const delivery = await preview(); await adoptManagedActivation('agent-1', delivery.token);
    let entered!: () => void; let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const runtime = vi.fn(async (lease) => {
      expect(lease).not.toBeNull(); expect(await fs.readFile(lease.instructionFile, 'utf8')).toBe('literal @@AgentName');
      await lease.beforeStart(W.binary); entered(); await hold;
      await lease.started('pty:fixture:123'); await lease.exited();
    });
    const run = withManagedActivationLaunch(params(), () => false, runtime);
    await enteredPromise;
    // This continuation is outside the transition owner's async context.
    await expect(withAgentActivity('agent-1', async () => undefined)).rejects.toMatchObject({ code: 'agent_transition_busy' });
    release(); await run;
    expect(runtime).toHaveBeenCalledOnce();
    expect(JSON.stringify(W.config)).toBe(before); expect(W.settingsSave).not.toHaveBeenCalled();
    expect(await fs.readdir(workspacePath)).toEqual([]);
    const state = (await readManagedActivation('agent-1'))!;
    expect(state.generations[state.desired!].runs[0]).toMatchObject({ outcome: 'pty_process_created', endedAt: expect.any(String) });
  });
  it('rejects commit when installed selection moves A to B even though A remains unchanged', async () => {
    const delivery = await preview(); const original = W.binary;
    W.binary = path.join(W.home, 'fake-claude-B'); await fs.writeFile(W.binary, 'fake binary B');
    await expect(adoptManagedActivation('agent-1', delivery.token)).rejects.toMatchObject({ code: 'activation_capability_stale' });
    expect(await fs.readFile(original, 'utf8')).toBe('fake binary A'); expect(await readManagedActivation('agent-1')).toBeNull();
  });
  it('rejects launch when installed selection moves A to B after adoption, before runtime callback', async () => {
    const delivery = await preview(); await adoptManagedActivation('agent-1', delivery.token);
    W.binary = path.join(W.home, 'fake-claude-B'); await fs.writeFile(W.binary, 'fake binary B');
    const runtime = vi.fn();
    await expect(withManagedActivationLaunch(params(), () => false, runtime)).rejects.toMatchObject({ code: 'activation_capability_stale' });
    expect(runtime).not.toHaveBeenCalled(); expect(await fs.readdir(workspacePath)).toEqual([]);
  });
  it.each(['hooks', 'mcp'] as const)('refuses existing enabled %s instead of changing it', async (setting) => {
    W[setting] = true;
    await expect(preview()).rejects.toMatchObject({ code: 'activation_incompatible_config' });
    expect(W.execute).not.toHaveBeenCalled(); expect(W.settingsSave).not.toHaveBeenCalled();
  });
  it.each(['resume', 'chat', 'provider', 'systemPrompt'] as const)('blocks unsupported %s without driver/provider/fresh fallback', async (kind) => {
    const delivery = await preview(); await adoptManagedActivation('agent-1', delivery.token);
    const start = params();
    if (kind === 'chat') W.runtime = 'chat';
    if (kind === 'provider') W.config!.orchestrator = 'codex-cli';
    const runtime = vi.fn();
    await expect(withManagedActivationLaunch({ ...start, ...(kind === 'resume' ? { resume: true, sessionId: 'old' } : {}), ...(kind === 'systemPrompt' ? { systemPrompt: 'extra hidden text' } : {}) }, () => false, runtime)).rejects.toMatchObject({ code: kind === 'resume' ? 'activation_resume_unproven' : 'activation_unsupported' });
    expect(runtime).not.toHaveBeenCalled();
  });
  it.each(['hooks', 'mcp', 'runtime', 'binary'] as const)('rechecks %s synchronously after intent save, at actual process-create boundary', async (setting) => {
    const delivery = await preview(); await adoptManagedActivation('agent-1', delivery.token);
    await withManagedActivationLaunch(params(), () => false, async (lease) => {
      await lease!.beforeStart(W.binary);
      if (setting === 'hooks') W.hooks = true;
      if (setting === 'mcp') W.mcp = true;
      if (setting === 'runtime') W.runtime = 'chat';
      if (setting === 'binary') { W.binary = path.join(W.home, 'late-B'); await fs.writeFile(W.binary, 'late binary B'); }
      expect(() => lease!.assertCanCreate()).toThrow(setting === 'binary' ? 'activation_capability_stale' : setting === 'runtime' ? 'activation_unsupported' : 'activation_incompatible_config');
      await lease!.notCreated();
    });
    const state = (await readManagedActivation('agent-1'))!;
    expect(state.generations[state.desired!].runs[0]).toMatchObject({ outcome: 'process_not_created', endedAt: expect.any(String) });
  });

});
