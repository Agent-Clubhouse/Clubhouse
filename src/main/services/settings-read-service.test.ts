import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';

const dirs = vi.hoisted(() => ({ userData: '', base: '' }));

vi.mock('electron', () => ({ app: { getPath: () => dirs.userData, isPackaged: false, getVersion: () => '0.0.0' } }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => dirs.base }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
const spawnAgent = vi.hoisted(() => vi.fn());
const getModelOptions = vi.hoisted(() => vi.fn());
const checkAvailability = vi.hoisted(() => vi.fn());
vi.mock('./agent-system', () => ({
  spawnAgent,
  checkAvailability,
  isAgentRunning: () => false,
  killAgent: vi.fn(),
  getAvailableOrchestrators: () => [
    { id: 'claude-code', capabilities: { permissions: true } },
    { id: 'codex-cli', capabilities: { permissions: false } },
  ],
  // agent-registry's precedence, without needing the providers registered.
  resolveOrchestrator: vi.fn(async (projectPath: string, id?: string) => {
    const { readProjectOrchestrator } = await import('./agent-registry');
    return { id: id ?? await readProjectOrchestrator(projectPath) ?? 'claude-code', getModelOptions };
  }),
  resolveProfileEnv: vi.fn(),
}));
vi.mock('./agent-creation', () => ({ parseStartCreationParams: vi.fn(), personaInjection: vi.fn(), startDurableCreation: vi.fn() }));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: () => ({}) }));
vi.mock('./agent-runtime', () => ({ isChatAgent: () => false }));
vi.mock('./git-service', () => ({ isInsideGitRepo: vi.fn(), getBranchChanges: vi.fn() }));
vi.mock('./mobile-control', () => ({ MobileControlError: class extends Error {} }));
vi.mock('./helper-index', () => ({ listHelpersEverywhere: vi.fn(async () => []) }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherAgentId: (id: string) => id === 'dispatcher',
  getDispatcherState: () => ({ enabled: true, flagOn: true, agentId: 'dispatcher', path: path.join(dirs.base, 'dispatcher'), config: null }),
}));

import { agentRegistry } from './agent-registry';
import * as agentConfig from './agent-config';
import { isOrchestrationEnabled, onOrchestrationGateChange, setOrchestrationEnabled } from './clubhouse-mcp/orchestration-gate';
import { getOrchestrationPolicy } from './orchestration-policy';
import { peekProjects } from './project-store';
import { resetAllSettingsStoresForTests } from './settings-store';
import {
  listSettings, MAX_PAGE, MAX_PAGE_CHARS, MAX_SELECT, readSettings, SettingsReadError,
  type ReadSettingsRequest, type SettingsActor,
} from './settings-read-service';

const CANARY = 'CANARY_SECRET_VALUE';
let root: string;
let one: string;
let two: string;

const ordinary = (agentId = 'a1'): SettingsActor => ({ scope: 'own', agentId, projectPath: one });
const dispatcher: SettingsActor = { scope: 'all', agentId: 'dispatcher' };

const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig =>
  ({ id, name: `${id}-name`, color: 'indigo', createdAt: '2026-01-01', ...extra });

function writeAgents(project: string, agents: unknown[]): void {
  fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify(agents));
}

function writeProjectSettings(project: string, settings: unknown): void {
  fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(project, '.clubhouse', 'settings.json'), JSON.stringify(settings));
}

function writeApp(filename: string, value: unknown): void {
  fs.writeFileSync(path.join(dirs.userData, filename), typeof value === 'string' ? value : JSON.stringify(value));
}

/** Every file under a folder with its bytes and mtime, and every folder. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out[`${full}/`] = '';
      Object.assign(out, snapshot(full));
    } else {
      out[full] = `${fs.statSync(full).mtimeMs}:${fs.readFileSync(full, 'utf-8')}`;
    }
  }
  return out;
}

async function refusal(promise: Promise<unknown>): Promise<SettingsReadError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SettingsReadError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

type Row = { target: string; id?: string; error?: string; truncated?: boolean; omitted?: string[]; not_applicable?: string[]; name?: string; project_id?: string; settings: Record<string, { stored?: unknown; effective: unknown; source: string; applies?: boolean }> };
const read = async (actor: SettingsActor, request: ReadSettingsRequest) => {
  const result = await readSettings(actor, request);
  return { ...result, targets: result.targets as Row[] };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-read-'));
  dirs.userData = path.join(root, 'user-data');
  dirs.base = path.join(root, 'base');
  one = path.join(root, 'one');
  two = path.join(root, 'two');
  for (const dir of [dirs.userData, dirs.base, one, two]) fs.mkdirSync(dir, { recursive: true });
  resetAllSettingsStoresForTests();
  spawnAgent.mockClear();
  getModelOptions.mockClear();
  checkAvailability.mockClear();
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  fs.writeFileSync(path.join(dirs.base, 'projects.json'), JSON.stringify({
    version: 1,
    projects: [
      { id: 'p1', name: 'one', path: one, displayName: 'Project One' },
      { id: 'p2', name: 'two', path: two },
    ],
  }));
  writeAgents(one, [agent('a1'), agent('peer'), agent('helper', { parentAgentId: 'a1' })]);
  writeAgents(two, [agent('b1')]);
});

afterEach(() => {
  // A loaded project keeps a watcher open, which holds its folder on Windows.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the OS clears its temp folder */ }
});

describe('the allowlist', () => {
  it('is exactly these keys: adding one is a decision this test makes you state', async () => {
    const { sections } = await listSettings(dispatcher);
    expect(Object.fromEntries(sections.map((s) => [s.section, s.keys.map((k) => k.slice(s.section.length + 1))]))).toEqual({
      'agent.identity': ['name', 'color', 'emoji', 'has_image'],
      'agent.cli': ['orchestrator', 'model', 'runtime'],
      'agent.persona': ['persona', 'mission'],
      'agent.access': ['free_agent_mode', 'permission_mode'],
      'agent.mcp': ['clubhouse_mcp', 'clubhouse_mode', 'mcp_ids'],
      'agent.idle': ['idle_sleep'],
      'agent.orchestration': ['orchestrate', 'access', 'control', 'max_helpers', 'cross_project_helpers', 'connect_to_dispatcher'],
      'project.identity': ['name', 'display_name', 'color', 'emoji', 'has_image'],
      'project.defaults': ['orchestrator', 'persona', 'mission', 'free_agent_mode', 'profile_id', 'source_control_provider', 'default_mcps'],
      'project.modes': ['clubhouse_mode', 'mcp', 'permission_mode'],
      'app.defaults': ['idle_timeout_minutes', 'chat_enabled', 'provider_runtime', 'mcp_enabled', 'clubhouse_mode_enabled', 'permission_mode', 'global_helper_cap', 'enabled_orchestrators'],
      'app.system': ['dispatcher_enabled', 'experimental_chat', 'experimental_copilot_sdk', 'experimental_dispatcher', 'annex_server_enabled', 'annex_client_enabled'],
    });
  });

  it('fails if a key that looks sensitive is ever listed', async () => {
    const { sections } = await listSettings(dispatcher);
    const sensitive = /token|secret|nonce|password|credential|api.?key|(^|[._])keys?($|[._])|(^|[._])env($|[._])|header|pairing|pin$|tls|cert|fingerprint|wrapper|prefix|telemetry|session|command|instructions|permissions|mcp_?json|mcp_?configs/i;
    for (const key of sections.flatMap((s) => s.keys)) expect(key).not.toMatch(sensitive);
  });

  it('never lets out a secret planted anywhere it could be, with detail on', async () => {
    writeAgents(one, [agent('a1', {
      mcpConfigs: { ado: { token: CANARY } },
      lastSessionId: CANARY,
      sessionHistory: [{ sessionId: CANARY, startedAt: '', lastActiveAt: '', friendlyName: CANARY }],
      buildCommand: `API_KEY=${CANARY} make`,
      testCommand: CANARY,
      lintCommand: CANARY,
      pendingTask: CANARY,
      agentFile: CANARY,
      agentSource: CANARY,
      handoff: { how: 'pushed', note: CANARY, at: '' },
      ...{ env: { TOKEN: CANARY }, nonce: CANARY, apiKey: CANARY, futureSecretSetting: CANARY },
    })]);
    writeProjectSettings(one, {
      agentDefaults: {
        instructions: CANARY,
        mcpJson: JSON.stringify({ mcpServers: { x: { env: { TOKEN: CANARY }, headers: { Authorization: CANARY } } } }),
        permissions: { allow: [CANARY] },
        commandPrefix: `export TOKEN=${CANARY} &&`,
        buildCommand: CANARY,
        testCommand: CANARY,
        lintCommand: CANARY,
        futureSecretSetting: CANARY,
      },
      launchWrapper: { binary: CANARY, separator: '--', orchestratorMap: {}, env: { TOKEN: CANARY } },
      futureSecretSetting: CANARY,
    });
    writeApp('annex-settings.json', { enableServer: true, enableClient: false, deviceName: CANARY, pairingPin: CANARY, tlsKey: CANARY });
    writeApp('telemetry-settings.json', { salt: CANARY, destinations: [{ otlp: { headers: { Authorization: CANARY } } }] });
    writeApp('mcp-settings.json', { enabled: true, futureSecretSetting: CANARY });
    writeApp('chat-runtime-settings.json', { 'claude-code': { mode: 'chat', apiKey: CANARY } });
    writeApp('orchestrator-settings.json', { enabled: ['claude-code'], futureSecretSetting: CANARY });
    writeApp('experimental-settings.json', { chat: true, futureSecretSetting: CANARY });
    resetAllSettingsStoresForTests();

    const { sections } = await listSettings(dispatcher);
    const select = sections.map((s) => s.section);
    const seen = [
      await readSettings(dispatcher, { select, agentIds: ['a1'], project: 'p1', detail: true }),
      await readSettings(ordinary(), { select: select.filter((s) => s !== 'app.system'), detail: true }),
      await listSettings(ordinary()),
    ];
    expect(JSON.stringify(seen)).not.toContain(CANARY);
    // And the read really did cover the planted records.
    expect(JSON.stringify(seen)).toContain('a1');
  });
});

describe('scope', () => {
  it('lets an agent read itself, its own project and the app defaults', async () => {
    const { targets } = await read(ordinary(), { select: ['agent.identity.name', 'project.identity.display_name', 'app.defaults.idle_timeout_minutes'] });
    expect(targets.map((t) => [t.target, t.id])).toEqual([['app', undefined], ['project', 'p1'], ['agent', 'a1']]);
    expect(targets[2].settings['agent.identity.name']).toEqual({ effective: 'a1-name', source: 'agent' });
  });

  it('accepts its own project by id, name or path, and its own id', async () => {
    for (const project of ['p1', 'Project One', one]) {
      const { targets } = await read(ordinary(), { select: ['project.identity.name'], project, agentIds: undefined });
      expect(targets[0].id).toBe('p1');
    }
    const { targets } = await read(ordinary(), { select: ['agent.identity.name'], agentIds: ['a1'] });
    expect(targets[0].id).toBe('a1');
  });

  it('refuses another agent the same way whether or not it exists', async () => {
    const select = ['agent.identity.name'];
    const peer = await refusal(readSettings(ordinary(), { select, agentIds: ['peer'] }));
    const elsewhere = await refusal(readSettings(ordinary(), { select, agentIds: ['b1'] }));
    const madeUp = await refusal(readSettings(ordinary(), { select, agentIds: ['no-such-agent'] }));
    expect(peer.code).toBe('out_of_scope');
    expect(peer.message).toBe(madeUp.message);
    expect(elsewhere.message).toBe(madeUp.message);
    expect(madeUp.message).not.toContain('no-such-agent');
  });

  it('refuses another project the same way whether or not it exists', async () => {
    const select = ['project.identity.name'];
    const real = await refusal(readSettings(ordinary(), { select, project: 'p2' }));
    const byPath = await refusal(readSettings(ordinary(), { select, project: two }));
    const madeUp = await refusal(readSettings(ordinary(), { select, project: 'no-such-project' }));
    expect(real.code).toBe('out_of_scope');
    expect(real.message).toBe(madeUp.message);
    expect(byPath.message).toBe(madeUp.message);
  });

  it('refuses the all-target forms for an ordinary agent', async () => {
    expect((await refusal(readSettings(ordinary(), { select: ['agent.identity.name'], allAgents: true, project: 'p1' }))).code).toBe('out_of_scope');
    expect((await refusal(readSettings(ordinary(), { select: ['project.identity.name'], allProjects: true }))).code).toBe('out_of_scope');
  });

  it('treats a helper as an ordinary agent: not its parent, not a sibling', async () => {
    const helper = ordinary('helper');
    expect((await read(helper, { select: ['agent.identity.name'] })).targets[0].id).toBe('helper');
    expect((await refusal(readSettings(helper, { select: ['agent.identity.name'], agentIds: ['a1'] }))).code).toBe('out_of_scope');
    expect((await refusal(readSettings(helper, { select: ['agent.identity.name'], agentIds: ['peer'] }))).code).toBe('out_of_scope');
    expect((await refusal(readSettings(helper, { select: ['project.identity.name'], project: 'p2' }))).code).toBe('out_of_scope');
  });

  it('hides Dispatcher-only settings: they read as unknown and aren\'t listed', async () => {
    const restricted = await refusal(readSettings(ordinary(), { select: ['app.system.dispatcher_enabled'] }));
    const section = await refusal(readSettings(ordinary(), { select: ['app.system'] }));
    const madeUp = await refusal(readSettings(ordinary(), { select: ['app.system.nothing'] }));
    for (const err of [restricted, section, madeUp]) expect(err.message).toMatch(/^Unknown setting: /);
    expect(restricted.message.replace('dispatcher_enabled', 'nothing')).toBe(madeUp.message);
    const { sections } = await listSettings(ordinary());
    expect(sections.map((s) => s.section)).not.toContain('app.system');
    expect(sections.map((s) => s.section)).toContain('app.defaults');
  });

  it('lists only what the caller can read now', async () => {
    const quick = await listSettings({ scope: 'own', agentId: 'quick-1', projectPath: one });
    expect(quick.sections.map((s) => s.section).some((s) => s.startsWith('agent.'))).toBe(false);
    expect(quick.sections.map((s) => s.section)).toContain('project.identity');

    const stray = fs.mkdtempSync(path.join(root, 'stray-'));
    writeAgents(stray, [agent('s1')]);
    const outside = await listSettings({ scope: 'own', agentId: 's1', projectPath: stray });
    expect(outside.sections.map((s) => s.section).some((s) => s.startsWith('project.'))).toBe(false);
    expect(outside.sections.map((s) => s.section)).toContain('agent.identity');
  });

  it('says a quick agent has no saved settings, and still reads its project', async () => {
    const quick: SettingsActor = { scope: 'own', agentId: 'quick-1', projectPath: one };
    expect((await refusal(readSettings(quick, { select: ['agent.identity.name'] }))).code).toBe('not_found');
    expect((await read(quick, { select: ['project.identity.name'] })).targets[0].id).toBe('p1');
  });

  it('lets the Dispatcher read any agent, any project and every app setting', async () => {
    const { targets } = await read(dispatcher, {
      select: ['agent.identity.name', 'project.identity.name', 'app.system.dispatcher_enabled'],
      agentIds: ['a1', 'b1', 'helper'], project: 'p2',
    });
    // Named with a project, it looks only there.
    expect(targets.map((t) => [t.target, t.id, t.error])).toEqual([
      ['app', undefined, undefined], ['project', 'p2', undefined], ['agent', 'a1', 'not_found'], ['agent', 'b1', undefined], ['agent', 'helper', 'not_found'],
    ]);
    const anywhere = await read(dispatcher, { select: ['agent.identity.name'], agentIds: ['a1', 'b1', 'no-such-agent'] });
    expect(anywhere.targets.map((t) => [t.id, t.error])).toEqual([['a1', undefined], ['b1', undefined], ['no-such-agent', 'not_found']]);
  });

  it('asks the Dispatcher to say which project, and reads its own record without one', async () => {
    expect((await refusal(readSettings(dispatcher, { select: ['project.identity.name'] }))).code).toBe('invalid');
    expect((await refusal(readSettings(dispatcher, { select: ['project.identity.name'], project: 'nope' }))).code).toBe('not_found');
    writeAgents(path.join(dirs.base, 'dispatcher'), [agent('dispatcher')]);
    const { targets } = await read(dispatcher, { select: ['agent.identity.name', 'agent.orchestration.orchestrate'] });
    expect(targets[0].id).toBe('dispatcher');
    expect(targets[0].settings['agent.identity.name'].effective).toBe('dispatcher-name');
    // Its orchestration is locked (#2533), so there is nothing to report.
    expect(targets[0].not_applicable).toEqual(['agent.orchestration.orchestrate']);
  });

  it('skips disposed agents', async () => {
    writeAgents(two, [agent('b1'), agent('gone', { disposedAt: '2026-01-02' })]);
    const { targets } = await read(dispatcher, { select: ['agent.identity.name'], project: 'p2', allAgents: true });
    expect(targets.map((t) => t.id)).toEqual(['b1']);
    expect((await read(dispatcher, { select: ['agent.identity.name'], agentIds: ['gone'] })).targets[0].error).toBe('not_found');
  });
});

describe('values and sources', () => {
  it('shows effective and source by default, and adds stored and names with detail', async () => {
    writeApp('chat-idle-settings.json', { idleTimeoutMinutes: 60 });
    resetAllSettingsStoresForTests();
    const compact = await read(ordinary(), { select: ['agent.idle.idle_sleep'] });
    expect(compact.targets[0]).toEqual({
      target: 'agent', id: 'a1',
      settings: { 'agent.idle.idle_sleep': { effective: 60, source: 'app', applies: false } },
    });
    const detail = await read(ordinary(), { select: ['agent.idle.idle_sleep'], detail: true });
    expect(detail.targets[0]).toMatchObject({ name: 'a1-name', project_id: 'p1' });
    expect(detail.targets[0].settings['agent.idle.idle_sleep']).toEqual({ stored: null, effective: 60, source: 'app', applies: false });
  });

  it('tells an agent\'s own value from an inherited one', async () => {
    writeAgents(one, [agent('a1', { idleSleep: 15 })]);
    expect((await read(ordinary(), { select: ['agent.idle.idle_sleep'], detail: true })).targets[0].settings['agent.idle.idle_sleep'])
      .toMatchObject({ stored: 15, effective: 15, source: 'agent' });
  });

  describe('an app value: presence in the file, never its value', () => {
    const idle = async () => (await read(ordinary(), { select: ['app.defaults.idle_timeout_minutes'], detail: true })).targets[0].settings['app.defaults.idle_timeout_minutes'];

    it('reads default with no file', async () => {
      expect(await idle()).toEqual({ stored: null, effective: 30, source: 'default' });
    });

    it('reads app when saved, even with the default\'s own value', async () => {
      writeApp('chat-idle-settings.json', { idleTimeoutMinutes: 30 });
      resetAllSettingsStoresForTests();
      expect(await idle()).toEqual({ stored: 30, effective: 30, source: 'app' });
    });

    it('reads default when the file holds other keys only', async () => {
      writeApp('chat-idle-settings.json', { somethingElse: true });
      resetAllSettingsStoresForTests();
      expect(await idle()).toEqual({ stored: null, effective: 30, source: 'default' });
    });

    it('reads uncertain when the file can\'t be read', async () => {
      writeApp('chat-idle-settings.json', '{ not json');
      resetAllSettingsStoresForTests();
      expect(await idle()).toEqual({ stored: null, effective: 30, source: 'uncertain' });
    });

    it('carries through to what an agent inherits', async () => {
      const source = async () => (await read(ordinary(), { select: ['agent.idle.idle_sleep'] })).targets[0].settings['agent.idle.idle_sleep'].source;
      expect(await source()).toBe('default');
      writeApp('chat-idle-settings.json', { idleTimeoutMinutes: 30 });
      resetAllSettingsStoresForTests();
      expect(await source()).toBe('app');
      writeApp('chat-idle-settings.json', '{ not json');
      expect(await source()).toBe('uncertain');
    });

    it('says default for a saved helper cap the store threw out', async () => {
      writeApp('orchestration-settings.json', { globalHelperCap: 100000 });
      resetAllSettingsStoresForTests();
      expect((await read(ordinary(), { select: ['app.defaults.global_helper_cap'], detail: true })).targets[0].settings['app.defaults.global_helper_cap'])
        .toEqual({ stored: 100000, effective: 20, source: 'default' });
    });
  });

  it('follows the MCP fallback chain: agent, project, app, Clubhouse mode', async () => {
    const mcp = async () => (await read(ordinary(), { select: ['agent.mcp.clubhouse_mcp'] })).targets[0].settings['agent.mcp.clubhouse_mcp'];
    expect(await mcp()).toEqual({ effective: true, source: 'default' });
    writeApp('mcp-settings.json', { enabled: true });
    resetAllSettingsStoresForTests();
    expect(await mcp()).toEqual({ effective: true, source: 'app' });
    writeApp('mcp-settings.json', { enabled: false, projectOverrides: { [one]: false } });
    resetAllSettingsStoresForTests();
    expect(await mcp()).toEqual({ effective: false, source: 'project' });
    writeAgents(one, [agent('a1', { mcpOverride: true })]);
    expect(await mcp()).toEqual({ effective: true, source: 'agent' });
    writeApp('mcp-settings.json', { enabled: false });
    writeAgents(one, [agent('a1')]);
    resetAllSettingsStoresForTests();
    expect(await mcp()).toEqual({ effective: false, source: 'default' });
    writeApp('clubhouse-mode-settings.json', { enabled: true });
    resetAllSettingsStoresForTests();
    expect(await mcp()).toEqual({ effective: true, source: 'app' });
  });

  it('gives a helper the bridge whatever is saved, as a fixed rule', async () => {
    writeAgents(one, [agent('helper', { parentAgentId: 'a1', mcpOverride: false })]);
    expect((await read(ordinary('helper'), { select: ['agent.mcp.clubhouse_mcp'], detail: true })).targets[0].settings['agent.mcp.clubhouse_mcp'])
      .toEqual({ stored: false, effective: true, source: 'default' });
  });

  it('inherits persona, mission, MCP ids and orchestrator from the project', async () => {
    writeProjectSettings(one, { orchestrator: 'codex-cli', defaultMcps: ['ado'], agentDefaults: { persona: 'qa', mission: 'ship' } });
    const { targets } = await read(ordinary(), { select: ['agent.persona', 'agent.mcp.mcp_ids', 'agent.cli.orchestrator'], detail: true });
    expect(targets[0].settings).toMatchObject({
      'agent.persona.persona': { stored: null, effective: 'qa', source: 'project' },
      'agent.persona.mission': { stored: null, effective: 'ship', source: 'project' },
      'agent.mcp.mcp_ids': { stored: null, effective: ['ado'], source: 'project' },
      'agent.cli.orchestrator': { stored: null, effective: 'codex-cli', source: 'project' },
    });
    writeAgents(one, [agent('a1', { persona: 'dev', mission: 'mine', mcpIds: [], orchestrator: 'claude-code' })]);
    const own = await read(ordinary(), { select: ['agent.persona', 'agent.mcp.mcp_ids', 'agent.cli.orchestrator'] });
    expect(own.targets[0].settings).toMatchObject({
      'agent.persona.persona': { effective: 'dev', source: 'agent' },
      'agent.persona.mission': { effective: 'mine', source: 'agent' },
      'agent.mcp.mcp_ids': { effective: [], source: 'agent' },
      'agent.cli.orchestrator': { effective: 'claude-code', source: 'agent' },
    });
  });

  it('reports orchestration with the policy\'s own sources, persona included', async () => {
    fs.mkdirSync(path.join(one, '.clubhouse', 'personas'), { recursive: true });
    fs.writeFileSync(path.join(one, '.clubhouse', 'personas', 'lead.md'), '---\norchestration: {"orchestrate": true, "maxHelpers": 3}\n---\nLead.\n');
    writeAgents(one, [agent('a1', { persona: 'lead', orchestration: { control: 'ask-everything' } })]);
    const { targets } = await read(ordinary(), { select: ['agent.orchestration'], detail: true });
    expect(targets[0].settings).toMatchObject({
      'agent.orchestration.orchestrate': { stored: null, effective: true, source: 'persona' },
      'agent.orchestration.max_helpers': { stored: null, effective: 3, source: 'persona' },
      'agent.orchestration.control': { stored: 'ask-everything', effective: 'ask-everything', source: 'agent' },
      'agent.orchestration.access': { stored: null, effective: 'same', source: 'default' },
    });
  });

  it('reports what an awake agent runs with, not only what is saved', async () => {
    writeAgents(one, [agent('a1', { freeAgentMode: true })]);
    expect((await read(ordinary(), { select: ['agent.access.free_agent_mode'] })).targets[0].settings['agent.access.free_agent_mode'].effective).toBe(true);
    agentRegistry.register('a1', { projectPath: one, orchestrator: 'claude-code', runtime: 'pty', launchAccess: { freeAgentMode: false, permissionMode: 'auto' } });
    const { settings } = (await read(ordinary(), { select: ['agent.access'] })).targets[0];
    expect(settings['agent.access.free_agent_mode'].effective).toBe(false);
    expect(settings['agent.access.permission_mode'].effective).toBe('auto');
  });
});

describe('limits', () => {
  const manyProjects = (count: number) => fs.writeFileSync(path.join(dirs.base, 'projects.json'), JSON.stringify({
    version: 1,
    projects: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `n${i}`, path: path.join(root, `n${i}`) })),
  }));

  it('refuses a select that is empty or too long, and a limit out of range', async () => {
    expect((await refusal(readSettings(ordinary(), { select: [] }))).code).toBe('invalid');
    expect((await refusal(readSettings(ordinary(), { select: Array(MAX_SELECT + 1).fill('agent.identity') }))).code).toBe('invalid');
    expect((await refusal(readSettings(ordinary(), { select: ['agent.identity'], limit: MAX_PAGE + 1 }))).code).toBe('invalid');
    expect((await refusal(readSettings(ordinary(), { select: ['agent.identity'], limit: 0 }))).code).toBe('invalid');
    expect((await refusal(readSettings(ordinary(), { select: ['agent.identity'], cursor: 'x' }))).code).toBe('invalid');
    expect((await refusal(readSettings(dispatcher, { select: ['agent.identity'], agentIds: Array(101).fill('x') }))).code).toBe('invalid');
    expect((await refusal(readSettings(dispatcher, { select: ['app.defaults'], allProjects: true }))).code).toBe('invalid');
    expect((await refusal(readSettings(dispatcher, { select: ['agent.identity'], allAgents: true }))).code).toBe('invalid');
  });

  it('pages through targets with a default page and a cursor, reaching every one once', async () => {
    manyProjects(23);
    const seen: Array<string | undefined> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await read(dispatcher, { select: ['project.identity.name'], allProjects: true, cursor });
      expect(page.total).toBe(23);
      expect(page.targets.length).toBeLessThanOrEqual(10);
      seen.push(...page.targets.map((t) => t.id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => `p${i}`));
  });

  it('stops a page at the size cap, however few targets that is, and the cursor carries on', async () => {
    const big = 'x'.repeat(1000);
    writeAgents(two, Array.from({ length: 25 }, (_, i) => agent(`b${i}`, { name: `${i}${big}`, persona: big, mission: big })));
    const { sections } = await listSettings(dispatcher);
    const select = sections.map((s) => s.section).filter((s) => s.startsWith('agent.'));
    const seen: Array<string | undefined> = [];
    let cursor: string | undefined;
    do {
      const page = await read(dispatcher, { select, project: 'p2', allAgents: true, limit: 25, detail: true, cursor });
      expect(JSON.stringify(page.targets).length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
      expect(page.targets.length).toBeLessThan(25);
      seen.push(...page.targets.map((t) => t.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `b${i}`));
  });

  it('cuts a single target too big for a page, naming what it left out', async () => {
    const huge = 'x'.repeat(MAX_PAGE_CHARS);
    writeAgents(one, [agent('a1', { mission: huge })]);
    const { targets, next_cursor } = await read(ordinary(), { select: ['agent.identity.name', 'agent.persona.mission'] });
    expect(JSON.stringify(targets).length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
    expect(targets[0].truncated).toBe(true);
    expect(targets[0].omitted).toEqual(['agent.persona.mission']);
    expect(targets[0].settings['agent.identity.name'].effective).toBe('a1-name');
    expect(next_cursor).toBeUndefined();
  });

  it('reads no target past the page', async () => {
    const reads = vi.spyOn(agentConfig, 'peekDurableConfigs');
    await read(dispatcher, { select: ['agent.identity.name'], agentIds: ['b1', 'a1', 'peer', 'helper'], limit: 1 });
    // b1 is the only target read: p1 then p2 for it.
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockRestore();
  });
});

describe('reads change nothing', () => {
  /** A project whose first load would write: a duplicate, a legacy flag, an interrupted creation. */
  function coldProject(): string {
    const cold = path.join(root, 'cold');
    writeAgents(cold, [
      agent('c1', { idleSleep: 15 }),
      agent('c1'),
      { ...agent('c2'), structuredMode: true },
      agent('c3', { creation: { state: 'creating', startedAt: '2026-01-01' } }),
      // Owned by project one, so loading this project would hand it a new id.
      agent('a1'),
    ]);
    fs.writeFileSync(path.join(dirs.base, 'projects.json'), JSON.stringify({
      version: 1,
      projects: [{ id: 'p1', name: 'one', path: one }, { id: 'pc', name: 'cold', path: cold }],
    }));
    return cold;
  }

  const everything = async () => {
    const { sections } = await listSettings(dispatcher);
    return sections.map((s) => s.section);
  };

  it('writes nothing, for a project not loaded yet included, while loading it does write', async () => {
    const cold = coldProject();
    await agentConfig.listDurable(one);
    writeApp('chat-idle-settings.json', { idleTimeoutMinutes: 60 });
    const before = snapshot(root);

    const select = await everything();
    await listSettings(ordinary());
    await readSettings(dispatcher, { select, project: 'pc', allAgents: true, limit: 25, detail: true });
    await readSettings(dispatcher, { select, project: 'pc', agentIds: ['c1'] });
    await readSettings(dispatcher, { select, allProjects: true, agentIds: ['c1', 'c2', 'a1'] });
    await readSettings(ordinary(), { select: select.filter((s) => s !== 'app.system') });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(snapshot(root)).toEqual(before);

    // The fixture is one the loading read would have changed, so the check above means something.
    await agentConfig.listDurable(cold);
    await agentConfig.flushAllAgentConfigs();
    expect(snapshot(root)).not.toEqual(before);
  });

  it('shows the records of a project not loaded yet as they are on disk', async () => {
    coldProject();
    const { targets } = await read(dispatcher, { select: ['agent.idle.idle_sleep'], project: 'pc', agentIds: ['c1'] });
    expect(targets[0].settings['agent.idle.idle_sleep']).toMatchObject({ effective: 15, source: 'agent' });
  });

  it('creates no folder for a project or base folder that isn\'t there', async () => {
    const gone = path.join(root, 'gone');
    fs.writeFileSync(path.join(dirs.base, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'pg', name: 'gone', path: gone }] }));
    await readSettings(dispatcher, { select: ['project.defaults', 'project.modes'], project: 'pg' });
    await readSettings(dispatcher, { select: ['agent.identity'], project: 'pg', allAgents: true });
    expect(fs.existsSync(gone)).toBe(false);

    dirs.base = path.join(root, 'no-base');
    expect(await peekProjects()).toEqual([]);
    expect(fs.existsSync(dirs.base)).toBe(false);
  });

  it('leaves a project store that needs migrating or recovery alone', async () => {
    const store = path.join(dirs.base, 'projects.json');
    fs.writeFileSync(store, JSON.stringify([{ id: 'p1', name: 'one', path: one }]));
    const before = snapshot(dirs.base);
    expect((await peekProjects()).map((p) => p.id)).toEqual(['p1']);
    expect(snapshot(dirs.base)).toEqual(before);

    fs.writeFileSync(store, '{ corrupt');
    const corrupt = snapshot(dirs.base);
    expect(await peekProjects()).toEqual([]);
    expect(snapshot(dirs.base)).toEqual(corrupt);
  });

  it('leaves the orchestration gate alone, where the policy read would close it', async () => {
    agentRegistry.register('a1', { projectPath: one, orchestrator: 'claude-code', runtime: 'pty' });
    setOrchestrationEnabled('a1', true);
    const gateChanges = vi.fn();
    const off = onOrchestrationGateChange(gateChanges);
    await readSettings(ordinary(), { select: ['agent.orchestration'] });
    await readSettings(dispatcher, { select: ['agent.orchestration'], agentIds: ['a1'] });
    expect(isOrchestrationEnabled('a1')).toBe(true);
    expect(gateChanges).not.toHaveBeenCalled();

    await getOrchestrationPolicy(one, 'a1');
    expect(isOrchestrationEnabled('a1')).toBe(false);
    off();
  });

  it('wakes nobody, asks no CLI, and fires no change listener', async () => {
    const select = await everything();
    const changed = vi.fn();
    const off = agentConfig.onAgentConfigChanged(changed);
    const registered = [...agentRegistry.getAllRegistrations().keys()];
    await readSettings(dispatcher, { select, project: 'p1', allAgents: true });
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(getModelOptions).not.toHaveBeenCalled();
    expect(checkAvailability).not.toHaveBeenCalled();
    // Only this test's projects: an earlier test's watcher can still fire as its folder goes.
    expect(changed).not.toHaveBeenCalledWith(one);
    expect(changed).not.toHaveBeenCalledWith(two);
    expect([...agentRegistry.getAllRegistrations().keys()]).toEqual(registered);
    off();
  });
});
