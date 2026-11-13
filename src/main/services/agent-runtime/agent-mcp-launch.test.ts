import { afterAll, afterEach, beforeEach as rawBeforeEach, describe, expect, it as rawIt, vi } from 'vitest';
import { existsSync, promises as fs, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators';
import type { AgentRuntime, ChatDriverStartOptions } from '../../../shared/chat';
import { CheckpointFixtureLifetime } from '../../../../test/checkpoint-fixture-lifetime';
import { ownedRegistration, preservingFailure } from '../../../../test/dispatcher-work-owner';

interface McpFixtureResources {
  directories: string[];
  agentId?: string;
  releases: Array<() => void>;
  closing: boolean;
}
const lifetime = vi.hoisted(() => ({
  current: undefined as CheckpointFixtureLifetime | undefined,
  resources: undefined as McpFixtureResources | undefined,
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { ownCheckpointExecFile } = await import('../../../../test/checkpoint-fixture-lifetime');
  return { ...actual, execFile: ownCheckpointExecFile(actual.execFile, () => lifetime.current) };
});
vi.mock('../managed-agents/git-excludes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../managed-agents/git-excludes')>();
  return {
    ...actual,
    queueManagedExcludes: (...args: Parameters<typeof actual.queueManagedExcludes>) => {
      if (!lifetime.current) throw new Error('Managed excludes have no fixture owner');
      return lifetime.current.observeDirect(actual.queueManagedExcludes(...args));
    },
  };
});

function owner(): CheckpointFixtureLifetime {
  if (!lifetime.current) throw new Error('MCP launch fixture is missing');
  return lifetime.current;
}
const it = ownedRegistration(rawIt, 1, (promise) => { owner().observeRaw(promise); });
const beforeEach = ownedRegistration(rawBeforeEach, 0, (promise) => { owner().observeRaw(promise); });

const fixture = vi.hoisted(() => ({ agents: [] as DurableAgentConfig[], running: false, starts: [] as ChatDriverStartOptions[], cacheAvailable: true, configGeneration: 0 }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/unused-synthetic-app' } }));
vi.mock('../agent-config', () => ({
  agentConfigGeneration: () => fixture.configGeneration,
  peekCachedDurableConfig: (_p: string, id: string) => fixture.cacheAvailable ? structuredClone(fixture.agents.find((a) => a.id === id) ?? null) : null,
  peekDurableConfigs: vi.fn(async () => fixture.agents),
  getDurableConfig: vi.fn(async (_p: string, id: string) => fixture.agents.find((a) => a.id === id)),
  touchSessionEntry: vi.fn(async () => {}), updateDurableConfig: vi.fn(async () => {}),
}));
vi.mock('../agent-system', () => ({
  resolveOrchestrator: vi.fn(async (_p: string, id?: string) => id === 'copilot-cli' ? copilot : claude),
  isAgentRunning: () => fixture.running,
  killAgent: vi.fn(async () => { await stopAllChatAgents(); fixture.running = false; }),
  spawnAgent: vi.fn(async (options: { resume?: boolean; sessionId?: string; orchestrator?: OrchestratorProvider['id'] }) => {
    await deliverForSpawn(root, agent, options.orchestrator === 'claude-code' ? claude : copilot); await start(options); fixture.running = true;
  }),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../mcp-bridge-starter', () => ({ ensureMcpBridge: vi.fn(async () => {}) }));
vi.mock('../hook-server', () => ({ waitReady: vi.fn(async () => 1234), portEnv: () => ({ CLUBHOUSE_HOOK_PORT: '1234' }) }));
vi.mock('../config-pipeline', () => ({ snapshotFile: vi.fn(), restoreForAgent: vi.fn() }));
vi.mock('../clubhouse-mcp/bridge-server', () => ({ waitReady: vi.fn(async () => 4321), NONCE_HEADER: 'X-Clubhouse-Nonce', agentEndpointUrl: () => 'http://127.0.0.1:4321/mcp' }));
vi.mock('../clubhouse-mcp/injection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../clubhouse-mcp/injection')>(),
  // No server/process: simulate injection creating the previously absent file.
  injectClubhouseMcp: vi.fn(async (cwd: string, _id: string, _port: number, conv: { mcpConfigFile: string }) => {
    const file = path.join(cwd, conv.mcpConfigFile);
    let config = { mcpServers: {} };
    try { config = JSON.parse(await fs.readFile(file, 'utf8')); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    config.mcpServers = { ...config.mcpServers, clubhouse: { command: 'synthetic-bridge' } };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(config));
  }),
  buildClubhouseMcpDef: vi.fn(() => ({ command: 'synthetic-live-bridge' })), CLUBHOUSE_NONCE_ENV: 'CLUBHOUSE_HOOK_NONCE',
}));
vi.mock('../chat-runtime-settings', () => ({ resolveRuntimeMode: () => ({ mode: 'chat' }) }));
vi.mock('../../util/shell', async (actual) => ({ ...await actual<typeof import('../../util/shell')>(), getShellEnvironment: () => ({ PATH: '/synthetic' }) }));
vi.mock('./chat-transcript', () => ({ appendChatEvent: vi.fn(async () => {}), listChatSessions: vi.fn(async () => []), readChatTranscript: vi.fn(async () => []) }));
vi.mock('../agent-exit-broadcast', () => ({ broadcastAgentExit: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../pty-manager', () => ({ isRunning: () => false, processIdentity: () => undefined }));

import { peekDurableConfigs } from '../agent-config';
import { withAgentActivity, withAgentTransition } from '../agent-transition';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { registerAgentSettingsHandlers } from '../../ipc/agent-settings-handlers';
import { tryStartChatAgent, stopAllChatAgents } from './chat-spawn';
import { FakeChatDriver } from './fake-chat-driver';
import { registerChatDriver, clearChatDrivers } from './chat-drivers';
import { clearChatRuntimes, getAgentRuntime } from './index';
import { appendChatEvent } from './chat-transcript';
import { clearDriverHealth } from './chat-driver-health';
import { injectClubhouseMcp } from '../clubhouse-mcp/injection';
import { localTomlMcpNotice } from '../agent-mcp-servers';
import { jsonMcpToToml } from '../toml-utils';
import { _setManagedAgentsForTesting, activationFor, deliverForSpawn, forgetDelivery, restartManagedAgent } from '../managed-agents';
import { createManagedAgentsService } from '../managed-agents/service';
import { createManagedStateStore } from '../managed-agents/state-store';
import { createAssetCatalogStore } from '../asset-catalog/store';
import { discoverManagedAssets } from '../managed-agents/discovery';
import { prepareManagedAssetImport } from '../managed-agents/imports';
import { withSettingsSurface } from '../settings-audit';
import { spawnAgent, killAgent, resolveOrchestrator } from '../agent-system';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { agentRegistry } from '../agent-registry';
import * as orchestrators from '../../orchestrators';
import { updateDurableConfig } from '../agent-config';

const conventions = { configDir: '.github', skillsDir: 'skills', agentTemplatesDir: 'agents', mcpConfigFile: '.github/mcp.json', localSettingsFile: 'hooks.json' };
const copilot = { id: 'copilot-cli', conventions, getBinaryPath: () => '/synthetic/copilot', writeInstructions: vi.fn() } as unknown as OrchestratorProvider;
const claude = { ...copilot, id: 'claude-code', conventions: { ...conventions, configDir: '.claude', mcpConfigFile: '.mcp.json' } } as OrchestratorProvider;
let root: string, cwd: string, settingsPath: string, localPath: string, agent: DurableAgentConfig;
let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
const projectMap = { inherited: { command: 'never-run-project' } };
const raw = (servers: object) => JSON.stringify({ mcpServers: servers });

beforeEach(async () => {
  lifetime.current?.assertRetired();
  lifetime.current = new CheckpointFixtureLifetime();
  const resources: McpFixtureResources = { directories: [], releases: [], closing: false };
  lifetime.resources = resources;
  vi.clearAllMocks(); clearChatDrivers(); clearChatRuntimes(); clearDriverHealth();
  fixture.running = false;
  fixture.cacheAvailable = true;
  fixture.configGeneration = 0;
  fixture.starts = [];
  await prepareMcpFixture(resources);
});

async function prepareMcpFixture(resources: McpFixtureResources): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-2849-'));
  resources.directories.push(root);
  cwd = path.join(root, 'agent'); localPath = path.join(cwd, conventions.mcpConfigFile);
  settingsPath = path.join(root, '.clubhouse/settings.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true }); await fs.mkdir(cwd);
  await fs.writeFile(settingsPath, JSON.stringify({ orchestrator: 'claude-code', agentDefaults: { mcpJson: raw(projectMap) } }));
  agent = { id: 'synthetic-agent', name: 'synthetic', color: 'blue', createdAt: '', worktreePath: cwd, orchestrator: 'copilot-cli' };
  resources.agentId = agent.id;
  agentRegistry.register(agent.id, { projectPath: root, orchestrator: 'copilot-cli', runtime: 'chat' });
  fixture.agents = [agent]; handlers = new Map();
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: never) => { handlers.set(channel, handler); });
  registerAgentSettingsHandlers();
}

function closeMcpFixture(current: CheckpointFixtureLifetime, resources: McpFixtureResources): Promise<void> {
  resources.closing = true;
  for (const release of resources.releases) release();
  return current.close(stopAllChatAgents, () => {
    clearChatDrivers(); clearChatRuntimes();
    if (resources.agentId) {
      agentRegistry.untrack(resources.agentId);
      forgetDelivery(resources.agentId);
    }
    _setManagedAgentsForTesting(null);
    for (const directory of resources.directories) rmSync(directory, { recursive: true, force: true });
  });
}

afterEach(async () => {
  const resources = lifetime.resources;
  if (!resources) throw new Error('MCP launch fixture resources are missing');
  await closeMcpFixture(owner(), resources);
});
afterAll(() => { lifetime.current?.assertRetired(); });

async function save(content: string) { return handlers.get(IPC.AGENT.WRITE_MCP_RAW_JSON)!({}, cwd, content, root, agent.id); }
function gatedSave() {
  const resources = lifetime.resources;
  if (!resources) throw new Error('MCP launch fixture resources are missing');
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  resources.releases.push(release);
  if (resources.closing) release();
  vi.mocked(peekDurableConfigs).mockImplementationOnce(async () => { await wait; return fixture.agents; });
  return { release, saving: owner().observeDirect(save(raw({ local: { command: 'never' } }))) };
}
async function start(options: { resume?: boolean; sessionId?: string; orchestrator?: OrchestratorProvider['id']; beforeCreate?: (runtime?: AgentRuntime) => void } = {}) {
  // No explicit legacy selection: exercise the standard Copilot SDK adapter.
  const provider = options.orchestrator === 'claude-code' ? claude : copilot;
  agentRegistry.register(agent.id, { projectPath: root, cwd, orchestrator: provider.id, runtime: 'pty' });
  const driver = new FakeChatDriver(provider.id === 'copilot-cli' ? 'copilot_sdk' : 'claude_stream_json', provider.id); registerChatDriver(driver);
  expect(await tryStartChatAgent({ agentId: agent.id, projectPath: root, cwd, kind: 'durable', permissionMode: 'auto', ...options }, provider, undefined, agent)).toBe('chat');
  fixture.starts.push(driver.last.startOptions!);
  return driver.last.startOptions!.mcpServers;
}

describe('#2849 effective-provider save → chat prepare (no provider/server)', () => {
  it('delivers an agent-only Copilot map, preserving project scope, unrelated entries and Claude file', async () => {
    const projectBefore = await fs.readFile(settingsPath, 'utf8');
    const claudeFile = path.join(cwd, '.mcp.json'); const claudeBefore = raw({ otherProvider: { command: 'never-run-claude' } });
    await fs.writeFile(claudeFile, claudeBefore);
    const servers = { 'example-mcp': { type: 'http', url: 'https://example.invalid/mcp' }, unrelated: { command: 'never-run-local' } };
    expect(await save(raw(servers))).toEqual({ ok: true });
    expect(await handlers.get(IPC.AGENT.READ_MCP_RAW_JSON)!({}, cwd, root, agent.id)).toBe(raw(servers));
    expect(await start()).toEqual({ ...servers, clubhouse: { command: 'synthetic-live-bridge' } });
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(projectBefore);
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(claudeBefore);
  });

  describe('#2855 managed import → add → restart → remove (fixture SDK, no paid probe)', () => {
    it('runs real stop and spawn with their owned sleep bookkeeping and no provider probe', async () => {
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async () => {}, isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
      agent.lastSessionId = 'original-native';
      await deliverForSpawn(root, agent, copilot);
      await start({ resume: true, sessionId: 'original-native' }); fixture.running = true;
      const original = getAgentRuntime(agent.id);
      const actual = await vi.importActual<typeof import('../agent-system')>('../agent-system');
      const availability = vi.fn(async () => ({ available: true }));
      const providerLookup = vi.spyOn(orchestrators, 'getProvider').mockImplementation((id) => {
        if (id !== copilot.id) throw new Error('Unexpected provider in the synthetic restart');
        return { ...copilot, checkAvailability: availability, getCapabilities: () => ({ headless: false, structuredOutput: false, hooks: false, sessionResume: false, permissions: true }) };
      });
      try {
        await vi.mocked(updateDurableConfig).withImplementation(async (_p, _id, updates) => {
          if (updates.lastSleep === null) delete agent.lastSleep;
          else if (updates.lastSleep) agent.lastSleep = updates.lastSleep;
          fixture.configGeneration++;
        }, async () => {
          await vi.mocked(killAgent).withImplementation(async (...args) => {
            await actual.killAgent(...args); fixture.running = false;
          }, async () => {
            await vi.mocked(spawnAgent).withImplementation(async (options) => {
              await actual.spawnAgent(options); fixture.running = true;
            }, async () => {
              expect(await restartManagedAgent(root, agent.id)).toEqual({ resumed: true });
            });
          });
        });
        expect(availability).toHaveBeenCalledOnce();
        expect(updateDurableConfig).toHaveBeenCalledWith(root, agent.id, { lastSleep: null });
        expect(getAgentRuntime(agent.id)).not.toBe(original);
        expect(getAgentRuntime(agent.id)?.isRunning()).toBe(true);
        expect(await service.latestRestartReceipt(agent.id)).toMatchObject({ outcome: 'completed', resumed: true });
      } finally { providerLookup.mockRestore(); }
    });

    describe('inner driver drift with a prepared running agent', () => {
      let service: ReturnType<typeof createManagedAgentsService>;
      beforeEach(async () => {
        service = createManagedAgentsService({
          catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
          state: createManagedStateStore(path.join(root, 'managed')),
          listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
          setManagedSetup: async () => {}, isRunning: () => fixture.running,
        });
        _setManagedAgentsForTesting(service);
        await service.ensureBuiltins();
        agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
        agent.lastSessionId = 'original-native';
        await deliverForSpawn(root, agent, copilot);
        await start(); fixture.running = true;
        await owner().settleEpoch(() => Promise.resolve());
      });

      it.each(['model', 'access', 'provider', 'session', 'managed', 'cache'] as const)('refuses %s drift during the inner driver probe', async (field) => {
        const actualStart = vi.spyOn(FakeChatDriver.prototype, 'start');
        const probe = vi.spyOn(FakeChatDriver.prototype, 'probe').mockImplementationOnce(async () => {
          await Promise.resolve();
          if (field === 'model') agent.model = 'changed-model';
          if (field === 'access') agent.access = 'full_access';
          if (field === 'provider') agent.orchestrator = 'claude-code';
          if (field === 'session') agent.lastSessionId = 'replacement-native';
          if (field === 'managed') delete agent.managed;
          if (field === 'cache') fixture.cacheAvailable = false;
          return { handshakeOk: true, capabilities: new FakeChatDriver().capabilities };
        });
        try {
          await expect(restartManagedAgent(root, agent.id)).rejects.toThrow('Managed restart failed');
          expect(probe).toHaveBeenCalledOnce();
          expect(actualStart).not.toHaveBeenCalled();
          expect(await service.latestRestartReceipt(agent.id)).toMatchObject({ outcome: 'failed' });
        } finally { probe.mockRestore(); actualStart.mockRestore(); }
      });
    });

    it('accepts only owned last-sleep bookkeeping across its actual chat stop and new driver start', async () => {
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async () => {}, isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
      agent.lastSessionId = 'original-native';
      await deliverForSpawn(root, agent, copilot);
      await start(); fixture.running = true;
      agent.lastSleep = { reason: 'user', at: new Date().toISOString() };
      vi.mocked(spawnAgent).mockImplementationOnce(async (options) => {
        delete agent.lastSleep;
        await start(options);
        fixture.running = true;
      });
      expect(await restartManagedAgent(root, agent.id)).toEqual({ resumed: true });
      expect(fixture.starts.at(-1)?.resumeNativeSessionId).toBe('original-native');
      expect(await service.latestRestartReceipt(agent.id)).toMatchObject({ outcome: 'completed' });
    });

    it('keeps an unrelated MCP, conversation, identity and other-provider bytes through import, migration and removal', async () => {
      const user = <T>(fn: () => T) => withSettingsSurface('ui', undefined, fn);
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [{ path: root, name: 'Project' }],
        listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async (_p, _id, setup) => { if (setup) agent.managed = setup; },
        isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      const unrelated = await user(() => service.createPart({ name: 'Unrelated fixture server',
        content: { kind: 'mcp', serverKey: 'unrelated', transport: 'stdio', command: 'never-run-unrelated' } }));
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [unrelated.id] };
      agent.lastSessionId = 'same-native-conversation';
      const identity = { id: agent.id, name: agent.name, orchestrator: agent.orchestrator, session: agent.lastSessionId };
      const otherProviderFile = path.join(cwd, '.mcp.json');
      await fs.writeFile(otherProviderFile, raw({ otherProvider: { command: 'never-run-other-provider' } }));
      const otherProviderBytes = await fs.readFile(otherProviderFile, 'utf8');
      await deliverForSpawn(root, agent, copilot);
      expect(await start()).toMatchObject({ unrelated: { command: 'never-run-unrelated' }, clubhouse: { command: 'synthetic-live-bridge' } });
      fixture.running = true;

      const sourceRoot = path.join(root, 'plain-source');
      const sourceSkill = path.join(sourceRoot, '.github/skills/imported-review');
      await fs.mkdir(path.join(sourceSkill, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(sourceSkill, 'SKILL.md'), '---\nname: imported-review\n---\nReview it without running scripts.\n');
      await fs.writeFile(path.join(sourceSkill, 'scripts/check.sh'), '#!/bin/sh\nexit 0\n');
      await fs.writeFile(path.join(sourceRoot, '.github/mcp.json'), raw({ imported: { command: 'never-run-imported' } }));
      const native = { root: sourceRoot, conventions: copilot.conventions };
      const discovered = await discoverManagedAssets(native);
      const imports: string[] = [];
      for (const candidate of discovered.candidates) {
        const plan = await prepareManagedAssetImport(service, native, { candidateId: candidate.id, mode: 'copy', name: `Fixture ${candidate.kind}` }, 'project-fixture');
        imports.push((await user(() => plan.commit('Dispatcher'))).id);
      }
      const [skill, mcp] = imports;
      await user(() => service.saveSetup(root, agent.id, { blocks: [], skills: [skill], mcps: [unrelated.id, mcp] }));
      expect(await activationFor(root, agent.id)).toMatchObject({ materialized: { matchesDesired: false }, providerConfirmedLoaded: { mcpTools: 'not_confirmed' } });
      await withSettingsSurface('mcp', 'dispatcher', () => restartManagedAgent(root, agent.id, { whenTurnEnds: true }));
      expect(getAgentRuntime(agent.id)?.kind).toBe('chat');
      const first = await activationFor(root, agent.id);
      expect(first).toMatchObject({ status: 'partial', lastRestart: { outcome: 'completed', resumed: true }, materialized: { matchesDesired: true }, verification: { status: 'blocked', attempts: 0 } });
      expect(await fs.readFile(path.join(cwd, '.github/skills/imported-review/scripts/check.sh'), 'utf8')).toContain('exit 0');
      const afterAdd = JSON.parse(await fs.readFile(path.join(cwd, conventions.mcpConfigFile), 'utf8'));
      expect(afterAdd.mcpServers).toMatchObject({ unrelated: { command: 'never-run-unrelated' }, imported: { command: 'never-run-imported' } });
      expect(fixture.starts[fixture.starts.length - 1]).toMatchObject({
        resumeNativeSessionId: identity.session,
        mcpServers: { unrelated: { command: 'never-run-unrelated' }, imported: { command: 'never-run-imported' }, clubhouse: { command: 'synthetic-live-bridge' } },
      });
      expect(spawnAgent).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: identity.id, orchestrator: 'copilot-cli', resume: true, sessionId: identity.session }));

      const moved = path.join(root, 'moved-agent');
      await fs.rename(cwd, moved);
      cwd = moved; agent.worktreePath = moved;
      await user(() => service.saveSetup(root, agent.id, { blocks: [], skills: [], mcps: [unrelated.id] }));
      await restartManagedAgent(root, agent.id, { whenTurnEnds: true });
      const afterRemove = JSON.parse(await fs.readFile(path.join(cwd, conventions.mcpConfigFile), 'utf8'));
      expect(afterRemove.mcpServers).toEqual({ unrelated: { command: 'never-run-unrelated' }, clubhouse: { command: 'synthetic-bridge' } });
      expect(fixture.starts[fixture.starts.length - 1]).toMatchObject({ resumeNativeSessionId: identity.session,
        mcpServers: { unrelated: { command: 'never-run-unrelated' }, clubhouse: { command: 'synthetic-live-bridge' } } });
      expect(fixture.starts[fixture.starts.length - 1].mcpServers).not.toHaveProperty('imported');
      await expect(fs.stat(path.join(cwd, '.github/skills/imported-review'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(cwd, '.mcp.json'), 'utf8')).toBe(otherProviderBytes);
      expect({ id: agent.id, name: agent.name, orchestrator: agent.orchestrator, session: agent.lastSessionId }).toEqual(identity);
      expect(await activationFor(root, agent.id)).toMatchObject({ status: 'partial', materialized: { matchesDesired: true }, providerConfirmedLoaded: { skills: 'not_confirmed', mcpTools: 'not_confirmed' } });
      expect(await fs.readFile(path.join(sourceRoot, '.github/mcp.json'), 'utf8')).toBe(raw({ imported: { command: 'never-run-imported' } }));
    });

    describe('restart outcomes with a prepared live fixture', () => {
      beforeEach(async () => {
        const service = createManagedAgentsService({
          catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
          state: createManagedStateStore(path.join(root, 'managed')),
          listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
          setManagedSetup: async () => {}, isRunning: () => fixture.running,
        });
        _setManagedAgentsForTesting(service);
        await service.ensureBuiltins();
        agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
        await deliverForSpawn(root, agent, copilot);
        await start(); fixture.running = true;
      });

      it('refuses revoked authorization before stopping the live fixture', async () => {
        await expect(restartManagedAgent(root, agent.id, { whenTurnEnds: true, authorize: async () => { throw new Error('revoked'); } })).rejects.toThrow('Managed restart failed');
        expect(killAgent).not.toHaveBeenCalled();
        expect(fixture.running).toBe(true);
      });

      it('records a restart failure without exposing provider diagnostics', async () => {
        vi.mocked(spawnAgent).mockRejectedValueOnce(new Error('password=must-not-appear'));
        await expect(restartManagedAgent(root, agent.id, { whenTurnEnds: true })).rejects.toThrow('Managed restart failed');
        expect(await activationFor(root, agent.id)).toMatchObject({ status: 'blocked', lastRestart: { outcome: 'failed' }, running: { status: 'stopped' } });
        expect(JSON.stringify(await activationFor(root, agent.id))).not.toContain('must-not-appear');
        expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.AGENT.AGENT_WAKE_FAILED, agent.id, expect.stringContaining('lifecycle receipt'));
        expect(JSON.stringify(vi.mocked(broadcastToAllWindows).mock.calls)).not.toContain('must-not-appear');
      });
    });

    it.each(['stop', 'start'] as const)('checks current authorization synchronously before the %s lifecycle effect', async (stage) => {
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async () => {}, isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
      await deliverForSpawn(root, agent, copilot);
      await start(); fixture.running = true;
      let checks = 0;
      await expect(restartManagedAgent(root, agent.id, {
        whenTurnEnds: true,
        authorize: async () => () => {
          if (++checks === (stage === 'stop' ? 1 : 2)) throw new Error('revoked before effect');
        },
      })).rejects.toThrow('Managed restart failed');
      expect(killAgent).toHaveBeenCalledTimes(stage === 'stop' ? 0 : 1);
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(fixture.running).toBe(stage === 'stop');
      expect(await service.latestRestartReceipt(agent.id)).toMatchObject({ outcome: 'failed' });
    });

    it.each(['stop', 'start'] as const)('does not replace a runtime recreated during %s authorization', async (stage) => {
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async () => {}, isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
      await deliverForSpawn(root, agent, copilot);
      await start(); fixture.running = true;
      let prepares = 0;
      await expect(restartManagedAgent(root, agent.id, {
        authorize: async () => {
          if (++prepares === (stage === 'stop' ? 1 : 2)) {
            await stopAllChatAgents();
            await start();
            fixture.running = true;
          }
          return () => {};
        },
      })).rejects.toThrow('Managed restart failed');
      expect(killAgent).toHaveBeenCalledTimes(stage === 'stop' ? 0 : 1);
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(fixture.running).toBe(true);
    });

    it('does not spawn or record completion when stop returns without stopping its runtime', async () => {
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async () => {}, isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
      await deliverForSpawn(root, agent, copilot);
      await start(); fixture.running = true;
      vi.mocked(killAgent).mockImplementationOnce(async () => {});
      await expect(restartManagedAgent(root, agent.id)).rejects.toThrow('Managed restart failed');
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(await service.latestRestartReceipt(agent.id)).toMatchObject({ outcome: 'failed' });
    });

    it('does not record completion when a cancelled start returns without a new runtime', async () => {
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async () => {}, isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
      await deliverForSpawn(root, agent, copilot);
      await start(); fixture.running = true;
      vi.mocked(spawnAgent).mockImplementationOnce(async () => {});
      await expect(restartManagedAgent(root, agent.id)).rejects.toThrow('Managed restart failed');
      expect(await service.latestRestartReceipt(agent.id)).toMatchObject({ outcome: 'failed' });
    });

    it('does not start a target made plain during the provider lookup', async () => {
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async () => {}, isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
      await deliverForSpawn(root, agent, copilot);
      await start(); fixture.running = true;
      vi.mocked(resolveOrchestrator).mockImplementationOnce(async () => { await Promise.resolve(); delete agent.managed; return copilot; });
      await expect(restartManagedAgent(root, agent.id)).rejects.toThrow('Managed restart failed');
      expect(spawnAgent).not.toHaveBeenCalled();
    });

    it.each(['before restart', 'during authorization preparation'] as const)('does not resume another provider conversation when the effective default changes %s', async (stage) => {
      const service = createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
        state: createManagedStateStore(path.join(root, 'managed')),
        listProjects: async () => [], listAgents: async () => [agent], getAgent: async () => agent,
        setManagedSetup: async () => {}, isRunning: () => fixture.running,
      });
      _setManagedAgentsForTesting(service);
      await service.ensureBuiltins();
      if (stage === 'before restart') delete agent.orchestrator;
      agent.managed = { version: 1, blocks: [], skills: [], mcps: [] };
      agent.lastSessionId = 'previous-copilot-conversation';
      await deliverForSpawn(root, agent, copilot);
      await start(); fixture.running = true;
      let preparations = 0;
      expect(await restartManagedAgent(root, agent.id, {
        authorize: async () => {
          if (stage === 'during authorization preparation' && ++preparations === 2) delete agent.orchestrator;
          return () => {};
        },
      })).toEqual({ resumed: false });
      expect(spawnAgent).toHaveBeenLastCalledWith(expect.objectContaining({ orchestrator: 'claude-code', resume: false, sessionId: undefined }));
      expect(fixture.starts[fixture.starts.length - 1].resumeNativeSessionId).toBeUndefined();
    });
  });
  it('saves an agent\'s own MCP file whatever the old Clubhouse Mode setting says (#2901)', async () => {
    agent.clubhouseModeOverride = undefined;
    expect(await save(raw({ local: { command: 'never' } }))).toEqual({ ok: true });
    expect(await start()).toEqual({ local: { command: 'never' }, clubhouse: { command: 'synthetic-live-bridge' } });
  });
  it('inherits project defaults only for a missing local file, before injection creates it', async () => {
    expect(await start()).toEqual({ ...projectMap, clubhouse: { command: 'synthetic-live-bridge' } });
  });
  it('keeps a deliberately empty local map empty through prepare', async () => {
    expect(await save(raw({}))).toEqual({ ok: true });
    expect(await start()).toEqual({ clubhouse: { command: 'synthetic-live-bridge' } });
  });
  it.each(['{broken-sensitive-content', raw({ broken: { type: 'socket', url: 'sensitive-url' } }), '{"mcpServers":[]}'])('blocks invalid local bytes without injection/overwrite, and permits deliberate valid repair (%s)', async (content) => {
    await fs.mkdir(path.dirname(localPath), { recursive: true }); await fs.writeFile(localPath, content);
    await expect(start()).rejects.toThrow(/MCP/);
    expect(await fs.readFile(localPath, 'utf8')).toBe(content);
    expect(injectClubhouseMcp).not.toHaveBeenCalled();
    expect(await handlers.get(IPC.AGENT.READ_MCP_RAW_JSON)!({}, cwd, root, agent.id)).toBe(content);
    expect(await save(raw({ repaired: { command: 'never-run-repaired' } }))).toEqual({ ok: true });
    expect(await start()).toHaveProperty('repaired');
  });
  it('cannot shadow the live bridge with a configured one of the same name', async () => {
    await save(raw({ clubhouse: { command: 'stale-do-not-run' }, custom: { command: 'never' } }));
    expect(await start()).toEqual({ custom: { command: 'never' }, clubhouse: { command: 'synthetic-live-bridge' } });
  });
  it('reserves Save before its first await against provider changes, starts and remaps', async () => {
    const { release, saving } = gatedSave();
    await preservingFailure(async () => {
      await expect(withAgentActivity(agent.id, async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
      await expect(withAgentTransition(agent.id, async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
      release(); expect(await saving).toEqual({ ok: true });
      await expect(withAgentActivity(agent.id, async () => 'available')).resolves.toBe('available');
    }, async () => { release(); await saving; });
  });
  it('releases and awaits owned Save after either reservation assertion fails', async () => {
    for (const failedCheck of ['activity', 'transition']) {
      const { release, saving } = gatedSave();
      const failure = new Error(`Injected ${failedCheck} assertion failure`);
      await expect(preservingFailure(async () => {
        expect(owner().evidence().teardown.directPending).toBeGreaterThan(0);
        await expect(withAgentActivity(agent.id, async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
        if (failedCheck === 'activity') throw failure;
        await expect(withAgentTransition(agent.id, async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
        throw failure;
      }, async () => { release(); await saving; })).rejects.toBe(failure);
      expect(await saving).toEqual({ ok: true });
      expect(await fs.readFile(localPath, 'utf8')).toBe(raw({ local: { command: 'never' } }));
      await expect(withAgentActivity(agent.id, async () => 'available')).resolves.toBe('available');
      await expect(withAgentTransition(agent.id, async () => 'available')).resolves.toBe('available');
    }
  });
  it('retires failed or late raw MCP setup without using the previous root or agent identity', async () => {
    const previousRoot = root;
    const previousAgentId = agent.id;
    const previous = path.join(previousRoot, 'previous-owner.txt');
    await fs.writeFile(previous, 'preserve previous fixture\n');
    const failedResources: McpFixtureResources = { directories: [], releases: [], closing: false };
    const failedOwner = new CheckpointFixtureLifetime();
    const failure = new Error('Injected settings write failure before agent assignment');
    const failingWrite = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure);
    const failedSetup = failedOwner.observeRaw(prepareMcpFixture(failedResources));
    await preservingFailure(async () => {
      await expect(failedSetup).rejects.toBe(failure);
      expect(failedResources.agentId).toBeUndefined();
      await closeMcpFixture(failedOwner, failedResources);
      failedOwner.assertRetired();
      expect(failedResources.directories.every((directory) => !existsSync(directory))).toBe(true);
      expect(agentRegistry.get(previousAgentId)?.projectPath).toBe(previousRoot);
      expect(await fs.readFile(previous, 'utf8')).toBe('preserve previous fixture\n');
    }, async () => {
      await Promise.allSettled([failedSetup]);
      try { await closeMcpFixture(failedOwner, failedResources); }
      finally { failingWrite.mockRestore(); }
    });

    const current = new CheckpointFixtureLifetime();
    const resources: McpFixtureResources = { directories: [], releases: [], closing: false };
    let release!: () => void;
    let entered!: () => void;
    let directory: string | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const mkdtemp = fs.mkdtemp;
    const spy = vi.spyOn(fs, 'mkdtemp').mockImplementationOnce(async (prefix) => {
      directory = await mkdtemp(prefix);
      entered(); await paused;
      return directory;
    });
    const setup = current.observeRaw(prepareMcpFixture(resources));
    let closing: Promise<void> | undefined;
    await preservingFailure(async () => {
      await Promise.race([ready, setup.then(() => { throw new Error('Setup settled before its mkdtemp gate'); })]);
      if (!directory) throw new Error('Late setup did not create an owned directory');
      expect(resources.directories).toEqual([]);
      expect(existsSync(directory)).toBe(true);
      closing = closeMcpFixture(current, resources);
      expect(() => current.assertRetired()).toThrow();
      release();
      await setup;
      await closing;
      current.assertRetired();
      expect(existsSync(directory)).toBe(false);
      const ownedAgentId = resources.agentId;
      if (!ownedAgentId) throw new Error('Late setup did not admit an owned agent identity');
      expect(agentRegistry.get(ownedAgentId)).toBeUndefined();
      expect(await fs.readFile(previous, 'utf8')).toBe('preserve previous fixture\n');
    }, async () => {
      release();
      await Promise.allSettled([setup]);
      try { await (closing ?? closeMcpFixture(current, resources)); }
      finally { spy.mockRestore(); }
    });
  });
  it.each(['provider', 'folder'])('revalidates an external %s change immediately before file write', async (change) => {
    let reads = 0;
    vi.mocked(peekDurableConfigs).mockImplementation(async () => {
      if (++reads === 2) {
        if (change === 'provider') agent.orchestrator = 'claude-code';
        else agent.worktreePath = root;
      }
      return fixture.agents;
    });
    await expect(save(raw({ local: { command: 'never' } }))).rejects.toThrow(/changed|do not match/);
    await expect(fs.readFile(localPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(cwd, '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('checks agent/project/worktree identity and requires identity for shared folders', async () => {
    const write = handlers.get(IPC.AGENT.WRITE_MCP_RAW_JSON)!;
    await expect(write({}, root, raw({}), root, agent.id)).rejects.toThrow('do not match');
    await expect(write({}, cwd, raw({}), root, 'other-agent')).rejects.toThrow('do not match');
    fixture.agents.push({ ...agent, id: 'shared-agent', orchestrator: 'claude-code' });
    await expect(write({}, cwd, raw({}), root)).rejects.toThrow('shared');
    expect(await save(raw({}))).toEqual({ ok: true });
  });
  it('starts without project servers when inherited canonical JSON is not JSON, with a notice, leaving project settings as they are (D10)', async () => {
    const bytes = JSON.stringify({ agentDefaults: { mcpJson: '{invalid-canonical-secret' } });
    await fs.writeFile(settingsPath, bytes);
    vi.mocked(appendChatEvent).mockClear();
    expect(await start()).toEqual({ clubhouse: { command: 'synthetic-live-bridge' } });
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(bytes);
    // A normal start writes the bridge locally; the project's bytes never reach it.
    expect(await fs.readFile(localPath, 'utf8').catch(() => '')).not.toContain('invalid-canonical-secret');
    expect(appendChatEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', data: expect.objectContaining({ code: 'mcp_configuration', message: expect.stringContaining('isn\'t valid JSON') }) }));
    expect(JSON.stringify(vi.mocked(appendChatEvent).mock.calls)).not.toContain('invalid-canonical-secret');
  });
  it('says in the chat which variables a server needs and the environment lacks, by name only (#2896, D95)', async () => {
    await save(raw({ workiq: { command: 'never', env_vars: ['SYNTHETIC_MISSING_VAR', 'PATH'] } }));
    vi.mocked(appendChatEvent).mockClear();
    await start();
    expect(appendChatEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', data: expect.objectContaining({
      code: 'mcp_server_env_missing', message: 'MCP server workiq can\'t start: SYNTHETIC_MISSING_VAR isn\'t set in your environment.',
    }) }));
    expect(JSON.stringify(vi.mocked(appendChatEvent).mock.calls)).not.toContain('/synthetic');
  });
  it('says nothing about variables when a command prefix runs first, since it can set them (D95)', async () => {
    await save(raw({ workiq: { command: 'never', env_vars: ['SYNTHETIC_MISSING_VAR'] } }));
    vi.mocked(appendChatEvent).mockClear();
    const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli'); registerChatDriver(driver);
    expect(await tryStartChatAgent({ agentId: agent.id, projectPath: root, cwd, kind: 'durable', permissionMode: 'auto' }, copilot, 'source .env', agent)).toBe('chat');
    expect(JSON.stringify(vi.mocked(appendChatEvent).mock.calls)).not.toContain('mcp_server_env_missing');
  });
  it('still rejects inherited canonical JSON that is not a valid MCP configuration', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ agentDefaults: { mcpJson: JSON.stringify({ servers: {} }) } }));
    await expect(start()).rejects.toThrow('mcpServers');
    expect(injectClubhouseMcp).not.toHaveBeenCalled();
  });
  it('preserves local TOML and delivers canonical JSON with a visible limitation notice', async () => {
    const file = path.join(cwd, '.codex/config.toml');
    const bytes = 'model = "unrelated"\n[mcp_servers.local]\ncommand = "never"';
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    const codex = { ...copilot, id: 'codex-cli', conventions: { ...conventions, mcpConfigFile: '.codex/config.toml', settingsFormat: 'toml' } } as OrchestratorProvider;
    const driver = new FakeChatDriver('codex_app_server', 'codex-cli'); registerChatDriver(driver);
    expect(await tryStartChatAgent({ agentId: agent.id, projectPath: root, cwd, kind: 'durable', permissionMode: 'auto' }, codex, undefined, agent)).toBe('chat');
    expect(driver.last.startOptions!.mcpServers).toEqual({ ...projectMap, clubhouse: { command: 'synthetic-live-bridge' } });
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect(injectClubhouseMcp).not.toHaveBeenCalled();
    expect(appendChatEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', data: expect.objectContaining({ code: 'mcp_configuration', message: localTomlMcpNotice(['local']) }) }));
  });
  // #2849: the notice is for a file that lists servers, not every Codex start.
  it.each([
    ['no local file', null],
    ['a local file with no MCP servers', 'model = "unrelated"\n'],
    ['only the Clubhouse bridge an older version wrote', '[mcp_servers.clubhouse]\ncommand = "node"\n'],
    ['exactly the project defaults Clubhouse wrote there', jsonMcpToToml(raw(projectMap))],
  ])('says nothing about local TOML with %s', async (_name, bytes) => {
    if (bytes !== null) {
      const file = path.join(cwd, '.codex/config.toml');
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    }
    const codex = { ...copilot, id: 'codex-cli', conventions: { ...conventions, mcpConfigFile: '.codex/config.toml', settingsFormat: 'toml' } } as OrchestratorProvider;
    const driver = new FakeChatDriver('codex_app_server', 'codex-cli'); registerChatDriver(driver);
    expect(await tryStartChatAgent({ agentId: agent.id, projectPath: root, cwd, kind: 'durable', permissionMode: 'auto' }, codex, undefined, agent)).toBe('chat');
    expect(driver.last.startOptions!.mcpServers).toEqual({ ...projectMap, clubhouse: { command: 'synthetic-live-bridge' } });
    expect(JSON.stringify(vi.mocked(appendChatEvent).mock.calls)).not.toContain('.codex/config.toml');
  });
});
