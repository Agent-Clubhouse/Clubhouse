import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators';
import type { ChatDriverStartOptions } from '../../../shared/chat';

const fixture = vi.hoisted(() => ({ agents: [] as DurableAgentConfig[], running: false, starts: [] as ChatDriverStartOptions[] }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/unused-synthetic-app' } }));
vi.mock('../agent-config', () => ({
  peekDurableConfigs: vi.fn(async () => fixture.agents),
  getDurableConfig: vi.fn(async (_p: string, id: string) => fixture.agents.find((a) => a.id === id)),
  touchSessionEntry: vi.fn(async () => {}), updateDurableConfig: vi.fn(async () => {}),
}));
vi.mock('../agent-system', () => ({
  resolveOrchestrator: vi.fn(async (_p: string, id?: string) => id === 'copilot-cli' ? copilot : claude),
  isAgentRunning: () => fixture.running,
  killAgent: vi.fn(async () => { await stopAllChatAgents(); fixture.running = false; }),
  spawnAgent: vi.fn(async (options: { resume?: boolean; sessionId?: string }) => {
    await deliverForSpawn(root, agent, copilot); await start(options); fixture.running = true;
  }),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-registry', () => ({ agentRegistry: { setNonce: vi.fn(), setRuntime: vi.fn(), get: vi.fn(), setLaunchCap: vi.fn(), setUserLaunchAccess: vi.fn(), reportLaunchAccess: vi.fn() }, untrackAgent: vi.fn() }));
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
vi.mock('../pty-manager', () => ({ isRunning: () => false }));

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
import { spawnAgent, killAgent } from '../agent-system';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';

const conventions = { configDir: '.github', skillsDir: 'skills', agentTemplatesDir: 'agents', mcpConfigFile: '.github/mcp.json', localSettingsFile: 'hooks.json' };
const copilot = { id: 'copilot-cli', conventions, getBinaryPath: () => '/synthetic/copilot', writeInstructions: vi.fn() } as unknown as OrchestratorProvider;
const claude = { ...copilot, id: 'claude-code', conventions: { ...conventions, configDir: '.claude', mcpConfigFile: '.mcp.json' } } as OrchestratorProvider;
let root: string, cwd: string, settingsPath: string, localPath: string, agent: DurableAgentConfig;
let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
const projectMap = { inherited: { command: 'never-run-project' } };
const raw = (servers: object) => JSON.stringify({ mcpServers: servers });

beforeEach(async () => {
  vi.clearAllMocks(); clearChatDrivers(); clearChatRuntimes(); clearDriverHealth();
  fixture.running = false;
  fixture.starts = [];
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-2849-'));
  cwd = path.join(root, 'agent'); localPath = path.join(cwd, conventions.mcpConfigFile);
  settingsPath = path.join(root, '.clubhouse/settings.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true }); await fs.mkdir(cwd);
  await fs.writeFile(settingsPath, JSON.stringify({ orchestrator: 'claude-code', agentDefaults: { mcpJson: raw(projectMap) } }));
  agent = { id: 'synthetic-agent', name: 'synthetic', color: 'blue', createdAt: '', worktreePath: cwd, orchestrator: 'copilot-cli' };
  fixture.agents = [agent]; handlers = new Map();
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: never) => { handlers.set(channel, handler); });
  registerAgentSettingsHandlers();
});
afterEach(async () => {
  await stopAllChatAgents(); clearChatDrivers(); clearChatRuntimes();
  forgetDelivery(agent.id); _setManagedAgentsForTesting(null);
  await fs.rm(root, { recursive: true, force: true });
});

async function save(content: string) { return handlers.get(IPC.AGENT.WRITE_MCP_RAW_JSON)!({}, cwd, content, root, agent.id); }
async function start(options: { resume?: boolean; sessionId?: string } = {}) {
  // No explicit legacy selection: exercise the standard Copilot SDK adapter.
  const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli'); registerChatDriver(driver);
  expect(await tryStartChatAgent({ agentId: agent.id, projectPath: root, cwd, kind: 'durable', permissionMode: 'auto', ...options }, copilot, undefined, agent)).toBe('chat');
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

    it('records a restart failure and refuses revoked authorization before stopping the live fixture', async () => {
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
      await expect(restartManagedAgent(root, agent.id, { whenTurnEnds: true, authorize: async () => { throw new Error('revoked'); } })).rejects.toThrow('Managed restart failed');
      expect(killAgent).not.toHaveBeenCalled();
      expect(fixture.running).toBe(true);
      vi.mocked(spawnAgent).mockRejectedValueOnce(new Error('password=must-not-appear'));
      await expect(restartManagedAgent(root, agent.id, { whenTurnEnds: true })).rejects.toThrow('Managed restart failed');
      expect(await activationFor(root, agent.id)).toMatchObject({ status: 'blocked', lastRestart: { outcome: 'failed' }, running: { status: 'stopped' } });
      expect(JSON.stringify(await activationFor(root, agent.id))).not.toContain('must-not-appear');
      expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.AGENT.AGENT_WAKE_FAILED, agent.id, expect.stringContaining('lifecycle receipt'));
      expect(JSON.stringify(vi.mocked(broadcastToAllWindows).mock.calls)).not.toContain('must-not-appear');
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
      expect(spawnAgent).toHaveBeenLastCalledWith(expect.objectContaining({ resume: false, sessionId: undefined }));
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
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    vi.mocked(peekDurableConfigs).mockImplementationOnce(async () => { await wait; return fixture.agents; });
    const saving = save(raw({ local: { command: 'never' } }));
    await expect(withAgentActivity(agent.id, async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
    await expect(withAgentTransition(agent.id, async () => {})).rejects.toMatchObject({ code: 'agent_transition_busy' });
    release(); expect(await saving).toEqual({ ok: true });
    await expect(withAgentActivity(agent.id, async () => 'available')).resolves.toBe('available');
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
