/**
 * The Dispatcher's helper settings from the tool through the real
 * setOrchestrationPolicy (#2661), with real agents.json files in a temp project.
 * dispatcher-controls.test.ts fakes the policy service; this covers what that
 * can't: the update, its authorization and its lock working together.
 *
 * Faked, because each reads app-wide settings or state outside the fixture: the
 * project list, MCP and helper-cap settings, whether the Dispatcher is on.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  base: '',
  project: '',
  /** Runs after a census reads the agents and before it resolves their policies. */
  afterList: null as null | (() => Promise<void>),
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => state.base }));
vi.mock('./project-store', () => ({
  list: vi.fn(async () => [{ id: 'p', name: 'project', path: state.project }]),
  onProjectsChanged: vi.fn(() => () => undefined),
}));
vi.mock('./mcp-settings', () => ({
  isMcpEnabled: () => true,
  onMcpEnablementChanged: vi.fn(() => () => undefined),
}));
vi.mock('./orchestration-settings', () => ({ getGlobalHelperCap: () => 20 }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherEnabled: () => true,
  isDispatcherAgentId: (id: string) => id === 'dispatcher',
  isDispatcherPath: () => false,
  onDispatcherChanged: vi.fn(() => () => undefined),
}));
vi.mock('./clubhouse-mcp/dispatcher-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('./clubhouse-mcp/dispatcher-gate')>(),
  isDispatcherAgent: (id: string) => id === 'dispatcher',
}));
vi.mock('./agent-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-config')>();
  return {
    ...actual,
    listDurable: async (projectPath: string) => {
      const listed = structuredClone(await actual.listDurable(projectPath));
      await state.afterList?.();
      return listed;
    },
  };
});

import { auditPath } from './dispatcher-audit';
import { flushAllAgentConfigs } from './agent-config';
import { callTool, _resetForTesting } from './clubhouse-mcp/tool-registry';
import { registerDispatcherControlTools } from './clubhouse-mcp/tools/dispatcher-control-tools';
import { isCrossProjectEnabled, isOrchestrationEnabled, setOrchestrationEnabled } from './clubhouse-mcp/orchestration-gate';
import { agentRegistry } from './agent-registry';
import { setOrchestratorHelpers } from './dispatcher-controls';
import { setOrchestrationPolicy } from './orchestration-policy';

const AGENT = { color: 'teal', createdAt: '2026-01-01T00:00:00.000Z' };
const CONNECTED = { orchestrate: true, connectToDispatcher: true };
// New for each test: agent-config reassigns an id it has seen in another project.
let run = 0;
let LEAD = '';
let OTHER = '';
let OFF = '';
let PLAIN = '';
let KID = '';
let KID2 = '';

function agentsFile(): string {
  return path.join(state.project, '.clubhouse', 'agents.json');
}

function writeAgents(agents: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(agentsFile()), { recursive: true });
  fs.writeFileSync(agentsFile(), JSON.stringify(agents.map((a) => ({ ...AGENT, name: `${a.id}-name`, ...a }))));
}

/** What is on disk, once anything queued has landed. */
async function saved(id: string): Promise<Record<string, unknown> | undefined> {
  await flushAllAgentConfigs();
  const agents = JSON.parse(fs.readFileSync(agentsFile(), 'utf-8')) as Array<{ id: string; orchestration?: Record<string, unknown> }>;
  return agents.find((a) => a.id === id)?.orchestration;
}

function auditRows(): Array<Record<string, unknown>> {
  if (!fs.existsSync(auditPath())) return [];
  return fs.readFileSync(auditPath(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const set = (args: Record<string, unknown>, caller = 'dispatcher') => callTool(caller, 'set_orchestrator_helpers', args);
const text = (r: { content: Array<{ text?: string }> }) => r.content[0].text ?? '';

beforeEach(() => {
  state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-policy-base-'));
  state.project = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-policy-project-'));
  state.afterList = null;
  run += 1;
  [LEAD, OTHER, OFF, PLAIN, KID, KID2] = ['lead', 'other', 'off', 'plain', 'kid', 'kidtwo'].map((name) => `durable_${run}_${name}`);
  writeAgents([
    { id: LEAD, orchestration: { ...CONNECTED, maxHelpers: 5, access: 'auto' } },
    { id: OTHER, orchestration: CONNECTED },
    { id: OFF, orchestration: { orchestrate: true, connectToDispatcher: false } },
    { id: PLAIN },
    { id: KID, parentAgentId: LEAD, orchestration: CONNECTED },
    { id: KID2, parentAgentId: LEAD },
  ]);
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  _resetForTesting();
  registerDispatcherControlTools();
  agentRegistry.register(LEAD, { projectPath: state.project, orchestrator: 'claude-code', runtime: 'chat' });
  agentRegistry.register(OTHER, { projectPath: state.project, orchestrator: 'claude-code', runtime: 'chat' });
  agentRegistry.register('dispatcher', { projectPath: state.base, orchestrator: 'claude-code', runtime: 'chat' });
});

afterEach(async () => {
  await flushAllAgentConfigs();
  setOrchestrationEnabled(LEAD, false);
  setOrchestrationEnabled(OTHER, false);
  fs.rmSync(state.base, { recursive: true, force: true });
  fs.rmSync(state.project, { recursive: true, force: true });
});

describe('the Dispatcher setting helpers through the real policy', () => {
  it('saves the change to the agent\'s config, audits it and leaves every other setting', async () => {
    const result = JSON.parse(text(await set({ agent_id: LEAD, cross_project_helpers: true, max_helpers: 7 })));
    expect(result).toMatchObject({ id: LEAD, cross_project_helpers: true, max_helpers: 7, global_cap: 20 });
    expect(await saved(LEAD)).toEqual({ ...CONNECTED, access: 'auto', crossProjectHelpers: true, maxHelpers: 7 });
    expect(auditRows().at(-1)).toMatchObject({
      outcome: 'ok', targets: [LEAD],
      before: { crossProjectHelpers: false, maxHelpers: 5 },
      after: { crossProjectHelpers: true, maxHelpers: 7 },
    });
  });

  it('opens a running agent\'s gate as the settings UI would, with its cross-project switch', async () => {
    expect(isOrchestrationEnabled(LEAD)).toBe(false);
    await set({ agent_id: LEAD, cross_project_helpers: true });
    expect(isOrchestrationEnabled(LEAD)).toBe(true);
    expect(isCrossProjectEnabled(LEAD)).toBe(true);
  });

  it('counts real helpers against a lower cap, stopping none', async () => {
    const result = JSON.parse(text(await set({ agent_id: LEAD, max_helpers: 1 })));
    expect(result).toMatchObject({ max_helpers: 1, live_helpers: 2, helpersOverCap: 1 });
    expect(await saved(KID)).toEqual(CONNECTED);
  });
});

describe('authorization together with the update', () => {
  it('another agent is refused at the registry and nothing is written', async () => {
    const before = fs.readFileSync(agentsFile(), 'utf-8');
    expect((await set({ agent_id: LEAD, max_helpers: 3 }, OTHER)).isError).toBe(true);
    await flushAllAgentConfigs();
    expect(fs.readFileSync(agentsFile(), 'utf-8')).toBe(before);
    expect(auditRows()).toEqual([]);
  });

  it('another agent past the registry is refused at the service and audited', async () => {
    const before = fs.readFileSync(agentsFile(), 'utf-8');
    await expect(setOrchestratorHelpers(OTHER, { agent_id: LEAD, max_helpers: 3 })).rejects.toMatchObject({ code: 'not_dispatcher' });
    await flushAllAgentConfigs();
    expect(fs.readFileSync(agentsFile(), 'utf-8')).toBe(before);
    expect(auditRows().at(-1)).toMatchObject({ actorId: OTHER, outcome: 'refused', code: 'not_dispatcher' });
  });

  it.each([
    ['Connect to Dispatcher off', () => OFF, 'not_connected_orchestrator'],
    ['orchestration off', () => PLAIN, 'not_connected_orchestrator'],
    ['a parent', () => KID, 'helper'],
  ])('refuses an agent with %s, from what its real config resolves to', async (_name, id, code) => {
    const before = fs.readFileSync(agentsFile(), 'utf-8');
    expect((await set({ agent_id: id(), max_helpers: 3 })).isError).toBe(true);
    await flushAllAgentConfigs();
    expect(fs.readFileSync(agentsFile(), 'utf-8')).toBe(before);
    expect(auditRows().at(-1)).toMatchObject({ outcome: 'refused', code });
  });

  it('refuses under the agent\'s lock when the user disconnects it after the first check', async () => {
    state.afterList = async () => {
      state.afterList = null;
      const outcome = await setOrchestrationPolicy(state.project, LEAD, { connectToDispatcher: false });
      expect(outcome.ok).toBe(true);
    };
    const result = await set({ agent_id: LEAD, max_helpers: 3 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('any more');
    expect(await saved(LEAD)).toEqual({ ...CONNECTED, connectToDispatcher: false, maxHelpers: 5, access: 'auto' });
    expect(auditRows().at(-1)).toMatchObject({ outcome: 'refused', code: 'not_connected_orchestrator' });
  });

  it('a user change queued on the same lock isn\'t lost to the tool\'s write', async () => {
    const [tool, user] = await Promise.all([
      set({ agent_id: LEAD, max_helpers: 3 }),
      setOrchestrationPolicy(state.project, LEAD, { crossProjectHelpers: true }),
    ]);
    expect(tool.isError).toBeFalsy();
    expect(user.ok).toBe(true);
    expect(await saved(LEAD)).toMatchObject({ maxHelpers: 3, crossProjectHelpers: true });
  });

  it('can\'t reach a field outside the two it names', async () => {
    for (const field of ['orchestrate', 'connectToDispatcher', 'access']) {
      expect((await set({ agent_id: LEAD, max_helpers: 3, [field]: false })).isError).toBe(true);
    }
    expect(await saved(LEAD)).toEqual({ ...CONNECTED, maxHelpers: 5, access: 'auto' });
  });
});
