import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators';

const fixture = vi.hoisted(() => ({ agents: [] as DurableAgentConfig[] }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/unused-synthetic-app' } }));
vi.mock('../agent-config', () => ({
  peekDurableConfigs: vi.fn(async () => fixture.agents),
  getDurableConfig: vi.fn(async (_p: string, id: string) => fixture.agents.find((a) => a.id === id)),
  touchSessionEntry: vi.fn(async () => {}), updateDurableConfig: vi.fn(async () => {}),
}));
vi.mock('../agent-system', () => ({ resolveOrchestrator: vi.fn(async (_p: string, id?: string) => id === 'copilot-cli' ? copilot : claude) }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-registry', () => ({ agentRegistry: { setNonce: vi.fn(), setRuntime: vi.fn(), get: vi.fn(), setLaunchCap: vi.fn(), setUserLaunchAccess: vi.fn(), reportLaunchAccess: vi.fn() }, untrackAgent: vi.fn() }));
vi.mock('../config-pipeline', () => ({ snapshotFile: vi.fn(), restoreForAgent: vi.fn() }));
vi.mock('../clubhouse-mcp/bridge-server', () => ({ waitReady: vi.fn(async () => 4321), NONCE_HEADER: 'X-Clubhouse-Nonce', agentEndpointUrl: () => 'http://127.0.0.1:4321/mcp' }));
vi.mock('../clubhouse-mcp/injection', () => ({
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
import { clearChatRuntimes } from './index';
import { appendChatEvent } from './chat-transcript';
import { clearDriverHealth } from './chat-driver-health';
import { injectClubhouseMcp } from '../clubhouse-mcp/injection';

const conventions = { configDir: '.github', skillsDir: 'skills', agentTemplatesDir: 'agents', mcpConfigFile: '.github/mcp.json', localSettingsFile: 'hooks.json' };
const copilot = { id: 'copilot-cli', conventions, getBinaryPath: () => '/synthetic/copilot', writeInstructions: vi.fn() } as unknown as OrchestratorProvider;
const claude = { ...copilot, id: 'claude-code', conventions: { ...conventions, configDir: '.claude', mcpConfigFile: '.mcp.json' } } as OrchestratorProvider;
let root: string, cwd: string, settingsPath: string, localPath: string, agent: DurableAgentConfig;
let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
const projectMap = { inherited: { command: 'never-run-project' } };
const raw = (servers: object) => JSON.stringify({ mcpServers: servers });

beforeEach(async () => {
  vi.clearAllMocks(); clearChatDrivers(); clearChatRuntimes(); clearDriverHealth();
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
afterEach(async () => { await stopAllChatAgents(); clearChatDrivers(); clearChatRuntimes(); await fs.rm(root, { recursive: true, force: true }); });

async function save(content: string) { return handlers.get(IPC.AGENT.WRITE_MCP_RAW_JSON)!({}, cwd, content, root, agent.id); }
async function start() {
  // No explicit legacy selection: exercise the standard Copilot SDK adapter.
  const driver = new FakeChatDriver('copilot_sdk', 'copilot-cli'); registerChatDriver(driver);
  expect(await tryStartChatAgent({ agentId: agent.id, projectPath: root, cwd, kind: 'durable', permissionMode: 'auto' }, copilot, undefined, undefined, agent)).toBe('chat');
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
  it('says in the chat which variables a server needs and the environment lacks, by name only (#2896, D91)', async () => {
    await save(raw({ workiq: { command: 'never', env_vars: ['SYNTHETIC_MISSING_VAR', 'PATH'] } }));
    vi.mocked(appendChatEvent).mockClear();
    await start();
    expect(appendChatEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', data: expect.objectContaining({
      code: 'mcp_server_env_missing', message: 'MCP server workiq can\'t start: SYNTHETIC_MISSING_VAR isn\'t set in your environment.',
    }) }));
    expect(JSON.stringify(vi.mocked(appendChatEvent).mock.calls)).not.toContain('/synthetic');
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
    expect(await tryStartChatAgent({ agentId: agent.id, projectPath: root, cwd, kind: 'durable', permissionMode: 'auto' }, codex, undefined, undefined, agent)).toBe('chat');
    expect(driver.last.startOptions!.mcpServers).toEqual({ ...projectMap, clubhouse: { command: 'synthetic-live-bridge' } });
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect(injectClubhouseMcp).not.toHaveBeenCalled();
    expect(appendChatEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', data: expect.objectContaining({ code: 'mcp_configuration', message: expect.stringContaining('local TOML servers are not delivered') }) }));
  });
});
