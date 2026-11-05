/**
 * What a running agent can call once Clubhouse MCP goes off, and what comes back
 * with it, through the real bridge over HTTP. Real settings IPC, tools, bindings,
 * wire sources, Dispatcher service, gates and agent config, in a temp folder.
 * Calls go straight to tools/call by name, as a CLI that keeps a stale tool list
 * would, so what's refused is refused by the server.
 *
 * Calls before MCP goes off have no arguments, so they get past the gate and stop
 * at their own validation with no side effects: not being refused is the point.
 * docs/settings-read-mcp.md has the table this proves: change both together.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const A = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs'); const nodeOs = require('os') as typeof import('os'); const nodePath = require('path') as typeof import('path');
  // The real path: the store compares project paths, and a macOS temp folder is a symlink.
  const dir = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mcp-off-')));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return { dir, handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() };
});

vi.mock('electron', () => ({
  app: { getPath: () => A.dir, isPackaged: false, getVersion: () => '0.0.0-harness', getName: () => 'mcp-off', on: () => {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => ({}) },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { A.handlers.set(channel, handler); }, on: () => {}, removeHandler: () => {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: {},
  dialog: {},
  Notification: class {},
}));
vi.mock('../../src/main/services/log-service', () => ({ appLog: () => {} }));

import { IPC } from '../../src/shared/ipc-channels';
import { settingsChannels } from '../../src/shared/settings-definitions';
import { MCP_OFF_HELPER_TOOL_MESSAGE, MCP_OFF_TOOL_MESSAGE, MCP_REQUIRED_MESSAGE, ORCHESTRATION_OFF_MESSAGE } from '../../src/shared/orchestration-policy';
import { resetNewChromeCacheForTests } from '../../src/main/window-chrome';
import { NEW_CHROME_FLAG } from '../../src/shared/chrome-flag';
import * as experimentalSettings from '../../src/main/services/experimental-settings';
import * as projectStore from '../../src/main/services/project-store';
import * as agentConfig from '../../src/main/services/agent-config';
import { agentRegistry } from '../../src/main/services/agent-registry';
import * as dispatcher from '../../src/main/services/dispatcher/dispatcher-service';
import { getSettings as getDispatcherSettings } from '../../src/main/services/dispatcher/dispatcher-settings';
import { syncOrchestrationGate, getOrchestrationPolicy } from '../../src/main/services/orchestration-policy';
import { syncDispatcherGate } from '../../src/main/services/clubhouse-mcp/dispatcher-gate';
import { bindingManager, bridgeServer } from '../../src/main/services/clubhouse-mcp';
import { setTargetToolTemplates } from '../../src/main/services/clubhouse-mcp/tool-registry';
import { setMcpCaller, setMcpCallerQuick } from '../../src/main/services/clubhouse-mcp/mcp-call-gate';
import { injectClubhouseMcp } from '../../src/main/services/clubhouse-mcp/injection';
import { registerBuiltinProviders } from '../../src/main/orchestrators';
import { registerChatRuntime } from '../../src/main/services/agent-runtime';
import { saveSettings as saveClubhouseMode } from '../../src/main/services/clubhouse-mode-settings';
import { MCP_UNBIND_CANVAS_CLEANUP } from '../../src/shared/mcp-unbind';
import { registerSettingsHandlers } from '../../src/main/ipc/settings-handlers';
import { registerDispatcherHandlers } from '../../src/main/ipc/dispatcher-handlers';
import { registerMcpBindingHandlers, maybeStartMcpBridge, restorePersistedBindings } from '../../src/main/ipc/mcp-binding-handlers';
import { addDispatcherConnections, dispatcherConnectionsPath, dispatcherConnectionSource, _resetDispatcherConnectionsForTesting } from '../../src/main/services/dispatcher-connections';
import { dispatcherWireBindingSource, _resetDispatcherWireSourceForTesting } from '../../src/main/services/dispatcher-wire-source';
import { canvasWireBindingSource } from '../../src/main/services/canvas-wire-source';
import { helperWireBindingSource, _resetHelperWireSourceForTesting } from '../../src/main/services/helper-wire-source';
import { connectionsStorePath, orchestratorConnectionSource, _resetOrchestratorConnectionsForTesting } from '../../src/main/services/orchestrator-connections';
import { rebuildPersistedBindings, registerPersistedBindingSource, _resetPersistedBindingSourcesForTesting } from '../../src/main/services/persisted-bindings';
import { readMcpOffImpact } from '../../src/main/services/mcp-off-impact';
import { groupProjectRegistry } from '../../src/main/services/group-project-registry';
import { listPausedPolling, resumePausedPolling, setProjectPolling, watchPollingForMcp, _pendingStartsForTesting } from '../../src/main/services/group-project-polling';
import { executeShoulderTap } from '../../src/main/services/group-project-shoulder-tap';

const ORCH = 'durable_orch';
const HELPER = 'durable_helper';
const HELPER2 = 'durable_helper2';
const HELPER_ON = 'durable_helper_on';
const HELPER_OFF = 'durable_helper_off';
const PLAIN = 'durable_plain';
const CODEX = 'durable_codex';
const PEER = 'durable_peer';
const REMOVED = 'durable_removed';
const QUITTER = 'durable_quitter';
const OWN_MCP = 'durable_own_mcp';
const OWN_OFF = 'durable_own_off';
const OTHER_ORCH = 'durable_other_orch';
const IN_OVERRIDE = 'durable_in_override';
const IN_CLUBHOUSE = 'durable_in_clubhouse';
const GROUP = 'gp_group';

const save = (settings: Record<string, unknown>) => A.handlers.get(settingsChannels('mcp').save)!({}, settings);

/** A client that does what a CLI with a stale list does: calls by name. */
async function client(agentId: string) {
  const nonce = `nonce-${agentId}`;
  agentRegistry.setNonce(agentId, nonce);
  const url = `http://127.0.0.1:${bridgeServer.getPort()}/mcp/${agentId}`;
  let sessionId: string | null = null;
  let id = 0;
  const headers = () => ({ 'X-Clubhouse-Nonce': nonce, ...(sessionId && { 'Mcp-Session-Id': sessionId }) });
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    return (await res.json()).result;
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-off', version: '1' } });
  return {
    names: async (): Promise<string[]> => (await rpc('tools/list')).tools.map((t: { name: string }) => t.name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      return { isError: !!result.isError, text: result.content?.[0]?.text as string };
    },
    /** What the server has pushed on this session's stream. */
    stream: async () => {
      const seen = { text: '' };
      const controller = new AbortController();
      const res = await fetch(url, { headers: { Accept: 'text/event-stream', ...headers() }, signal: controller.signal });
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) seen.text += decoder.decode(chunk);
      })().catch(() => {});
      return { seen, close: () => controller.abort() };
    },
  };
}
type Client = Awaited<ReturnType<typeof client>>;

const toolEndingIn = (names: string[], part: string, suffix: string) => names.find((n) => n.includes(part) && n.endsWith(`__${suffix}`));

/** A fake chat runtime: enough for a message to reach it. */
function fakeRuntime(agentId: string) {
  const sent: string[] = [];
  registerChatRuntime({
    agentId, kind: 'chat', isRunning: () => true, getState: () => 'idle', getCapabilities: () => ({}), onStateChange: () => () => {}, onExit: () => () => {},
    sendMessage: async (text: string) => { sent.push(text); return { delivery: 'prompt' }; },
  } as never);
  return sent;
}

describe('Clubhouse MCP going off, for running agents', () => {
  let projectPath = '';
  let overridePath = '';
  let clubhousePath = '';
  let dispatcherId = '';
  const clients = {} as Record<string, Client>;
  /** Names read while everything was on: a stale list is exactly what a CLI like Codex keeps. */
  const listed = {} as Record<string, string[]>;

  const hasBinding = (agentId: string, targetId: string) => bindingManager.getBindingsForAgent(agentId).some((b) => b.targetId === targetId);

  /** What spawnAgent does for the gates, before the MCP connects. */
  async function start(id: string, path_: string, orchestrator = 'claude-code'): Promise<void> {
    agentRegistry.register(id, { projectPath: path_, orchestrator, runtime: 'chat' } as never);
    await syncOrchestrationGate(path_, id);
    await syncDispatcherGate(path_, id);
    setMcpCaller(id, path_, await agentConfig.getDurableConfig(path_, id));
    clients[id] = await client(id);
  }

  let polledProject = '';
  let loopingProject = '';
  let polledSent: string[] = [];

  /** Every group, as [caller, tool]. Filled in once the wires are up. */
  let everyGroup: Array<[label: string, caller: string, tool: string]> = [];

  beforeAll(async () => {
    experimentalSettings.saveSettings({ [NEW_CHROME_FLAG]: true });
    resetNewChromeCacheForTests();
    registerBuiltinProviders();

    const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, color: 'indigo', createdAt: '2026-01-01', orchestrator: 'claude-code', ...extra });
    const project = (name: string, agents: unknown[]) => {
      const dir = path.join(A.dir, name);
      fs.mkdirSync(path.join(dir, '.clubhouse'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.clubhouse', 'agents.json'), JSON.stringify(agents));
      return dir;
    };
    projectPath = project('project-one', [
      agent(ORCH, 'conductor', { orchestration: { orchestrate: true, crossProjectHelpers: true } }),
      agent(HELPER, 'runner', { parentAgentId: ORCH }),
      agent(HELPER2, 'walker', { parentAgentId: ORCH }),
      agent(HELPER_ON, 'helper-on', { parentAgentId: ORCH, mcpOverride: true }),
      agent(HELPER_OFF, 'helper-off', { parentAgentId: ORCH, mcpOverride: false }),
      agent(PLAIN, 'plain'),
      agent(CODEX, 'codex', { orchestrator: 'codex-cli' }),
      agent(PEER, 'peer', { orchestration: { orchestrate: true } }),
      agent(REMOVED, 'removed', { orchestration: { orchestrate: true } }),
      agent(QUITTER, 'quitter', { orchestration: { orchestrate: true } }),
      agent(OWN_MCP, 'own-mcp', { mcpOverride: true, orchestration: { orchestrate: true } }),
      agent(OWN_OFF, 'own-off', { mcpOverride: false }),
      agent(OTHER_ORCH, 'other-orch', { orchestration: { orchestrate: true, connectToDispatcher: false } }),
    ]);
    overridePath = project('project-override', [agent(IN_OVERRIDE, 'in-override', { orchestration: { orchestrate: true } })]);
    clubhousePath = project('project-clubhouse', [agent(IN_CLUBHOUSE, 'in-clubhouse')]);
    for (const dir of [projectPath, overridePath, clubhousePath]) await projectStore.add(dir);

    registerSettingsHandlers();
    registerMcpBindingHandlers();
    registerDispatcherHandlers();
    await dispatcher.initDispatcher();
    await restorePersistedBindings();
    maybeStartMcpBridge();
    await bridgeServer.waitReady();
    dispatcherId = dispatcher.getDispatcherAgentId()!;
    expect(dispatcherId).toBeTruthy();
    // On by default, and nothing started it.
    expect(dispatcher.getDispatcherState()).toMatchObject({ enabled: true, running: false });

    // A wire the user drew, a group project, a browser widget and a plugin.
    bindingManager.bind(ORCH, { targetId: PLAIN, targetKind: 'agent', label: 'plain', targetName: 'plain', projectName: 'project-one' });
    bindingManager.bind(OWN_MCP, { targetId: PLAIN, targetKind: 'agent', label: 'plain', targetName: 'plain', projectName: 'project-one' });
    bindingManager.bind(OWN_MCP, { targetId: PEER, targetKind: 'agent', label: 'peer', targetName: 'peer', projectName: 'project-one' });
    bindingManager.bind(CODEX, { targetId: PLAIN, targetKind: 'agent', label: 'plain', targetName: 'plain', projectName: 'project-one' });
    bindingManager.bind(PLAIN, { targetId: GROUP, targetKind: 'group-project', label: 'group', targetName: 'group' });
    bindingManager.bind(PLAIN, { targetId: 'browser-1', targetKind: 'browser', label: 'widget' });
    setTargetToolTemplates('plugin', 'acme', [{
      nameSuffix: 'ping', definition: { description: 'ping', inputSchema: { type: 'object', properties: {} } },
      handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    }]);
    bindingManager.bind(PLAIN, { targetId: 'acme', targetKind: 'plugin', label: 'acme' });
    // Links the Dispatcher made, one of them removed by the user later.
    await addDispatcherConnections([
      { agentId: ORCH, targetId: PEER, agentProjectPath: projectPath, targetProjectPath: projectPath, createdAt: 'now', createdBy: dispatcherId },
      { agentId: ORCH, targetId: REMOVED, agentProjectPath: projectPath, targetProjectPath: projectPath, createdAt: 'now', createdBy: dispatcherId },
    ]);
    // Wires the orchestrator made with connect_agents, one of them removed by the user later.
    fs.mkdirSync(path.dirname(connectionsStorePath(projectPath)), { recursive: true });
    fs.writeFileSync(connectionsStorePath(projectPath), JSON.stringify({ version: 1, connections: [
      { ownerId: ORCH, agentId: HELPER, targetId: HELPER2, targetKind: 'agent', createdAt: 'now' },
      { ownerId: ORCH, agentId: HELPER2, targetId: HELPER, targetKind: 'agent', createdAt: 'now' },
    ] }));
    await restorePersistedBindings();
    await vi.waitFor(() => {
      expect(hasBinding(ORCH, dispatcherId)).toBe(true);
      expect(hasBinding(ORCH, PEER)).toBe(true);
      expect(hasBinding(HELPER, HELPER2)).toBe(true);
      expect(hasBinding(HELPER2, HELPER)).toBe(true);
    });

    for (const id of [ORCH, HELPER, HELPER_ON, HELPER_OFF, PLAIN, OWN_MCP, OWN_OFF]) await start(id, projectPath);
    await start(CODEX, projectPath, 'codex-cli');
    await start(IN_OVERRIDE, overridePath);
    await start(IN_CLUBHOUSE, clubhousePath);
    await start(dispatcherId, dispatcher.getDispatcherPath());
    for (const id of Object.keys(clients)) listed[id] = await clients[id].names();

    everyGroup = [
      ...['start_helper', 'list_helpers', 'sleep_helper', 'wake_helper', 'hand_off', 'dispose_helper', 'answer_helper_question', 'list_models',
        'connect_agents', 'disconnect_agents', 'create_group_project', 'add_to_group_project', 'remove_from_group_project'].map((t): [string, string, string] => ['orchestration', ORCH, t]),
      ['cross-project', ORCH, 'list_projects'],
      ...['list_agents', 'inspect_helper', 'set_orchestrator_helpers', 'connect_orchestrators', 'disconnect_orchestrators', 'list_orchestrator_controls'].map((t): [string, string, string] => ['dispatcher', dispatcherId, t]),
      ['dispatcher wire', dispatcherId, toolEndingIn(listed[dispatcherId], 'conductor', 'send_message')!],
      ['dispatcher wire', dispatcherId, toolEndingIn(listed[dispatcherId], 'conductor', 'sleep_agent')!],
      ['wire to the Dispatcher', ORCH, toolEndingIn(listed[ORCH], 'Dispatcher', 'send_message')!],
      ['link the Dispatcher made', ORCH, toolEndingIn(listed[ORCH], 'peer', 'get_status')!],
      ['canvas wire', ORCH, toolEndingIn(listed[ORCH], 'plain', 'send_message')!],
      ['canvas wire', ORCH, toolEndingIn(listed[ORCH], 'plain', 'get_status')!],
      ['helper wire', ORCH, toolEndingIn(listed[ORCH], 'runner', 'send_message')!],
      ['connect_agents wire', HELPER, toolEndingIn(listed[HELPER], 'walker', 'get_status')!],
      ['group project', PLAIN, toolEndingIn(listed[PLAIN], 'group', 'list_members')!],
      ['group project', PLAIN, toolEndingIn(listed[PLAIN], 'group', 'post_bulletin')!],
      ['browser', PLAIN, listed[PLAIN].find((n) => n.startsWith('browser__'))!],
      ['plugin', PLAIN, listed[PLAIN].find((n) => n.startsWith('plugin__'))!],
      ['call_wire_tool', CODEX, 'call_wire_tool'],
      ...['list_settings', 'read_settings', 'notify_user', 'update_agent', 'update_project'].map((t): [string, string, string] => ['global', PLAIN, t]),
    ];
    for (const [label, caller, tool] of everyGroup) expect(tool, `${label} for ${caller}`).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    bridgeServer.stop();
    try { fs.rmSync(A.dir, { recursive: true, force: true }); } catch { /* the OS clears its temp folder */ }
  });

  const refusedForMcp = (result: { isError: boolean; text: string }) => result.isError && result.text === MCP_OFF_TOOL_MESSAGE;

  it('before: every group gets past the gate', async () => {
    for (const [label, caller, tool] of everyGroup) {
      if (caller === HELPER) continue; // A helper's own row is below.
      const result = await clients[caller].call(tool);
      expect(refusedForMcp(result), `${label}: ${tool} ${result.text}`).toBe(false);
      expect(result.text ?? '', `${label}: ${tool}`).not.toContain('No binding found');
    }
  });

  it('counts what it would do, before anything changes', async () => {
    const impact = await readMcpOffImpact({ mcp: { enabled: false } });
    expect(impact).toMatchObject({
      turnsOff: true, appLoses: true, dispatcherGoesOff: true, dispatcherRunning: true, runningOrchestratorsWithHelpers: 1,
      keeps: { projects: [], agents: [{ name: 'helper-on', project: 'project-one' }, { name: 'own-mcp', project: 'project-one' }] },
    });
    expect(dispatcher.isDispatcherEnabled()).toBe(true);
  });

  describe('with MCP off at app level', () => {
    let pushed: Awaited<ReturnType<Client['stream']>>;

    beforeAll(async () => {
      pushed = await clients[PLAIN].stream();
      // A member already polling, through the real toggle.
      watchPollingForMcp();
      polledSent = fakeRuntime(CODEX);
      const looping = await groupProjectRegistry.create('looping');
      loopingProject = looping.id;
      bindingManager.bind(CODEX, { targetId: looping.id, targetKind: 'group-project', label: 'looping' });
      await setProjectPolling(looping.id, true);
      expect(polledSent.filter((m) => m.includes('start polling for "looping"'))).toHaveLength(1);
      await save({ enabled: false, projectDefault: true, projectOverrides: { [overridePath]: true } });
      await saveClubhouseMode({ enabled: false, projectOverrides: { [clubhousePath]: true } });
      // Pruning follows the save within moments; the rebuild is debounced.
      await vi.waitFor(() => {
        expect(hasBinding(ORCH, dispatcherId)).toBe(false);
        expect(hasBinding(ORCH, PEER)).toBe(false);
      }, { timeout: 10_000 });
    }, 30_000);
    afterAll(() => pushed.close());

    it('stops nothing: every agent is still running, the Dispatcher derived off, nothing saved changed', () => {
      for (const id of [ORCH, HELPER, PLAIN, dispatcherId]) expect(agentRegistry.get(id)).toBeTruthy();
      expect(dispatcher.getDispatcherState()).toMatchObject({ enabled: false, savedOn: true, offReason: 'mcp_off', running: true });
      expect(getDispatcherSettings().enabled).toBeUndefined();
    });

    it('refuses every group, for a client still holding the tool, with plain words', async () => {
      for (const [label, caller, tool] of everyGroup) {
        const result = await clients[caller].call(tool);
        const expected = caller === HELPER ? MCP_OFF_HELPER_TOOL_MESSAGE : MCP_OFF_TOOL_MESSAGE;
        expect(result, `${label}: ${tool}`).toEqual({ isError: true, text: expected });
      }
    });

    it('lists nothing to an agent without MCP, and tells its CLI to re-list', async () => {
      for (const id of [ORCH, PLAIN, CODEX, dispatcherId, OWN_OFF]) expect(await clients[id].names(), id).toEqual([]);
      await vi.waitFor(() => expect(pushed.seen.text).toContain('notifications/tools/list_changed'), { timeout: 10_000 });
    });

    it('the Dispatcher stays refused whatever overrides exist, and stays stoppable', async () => {
      expect(refusedForMcp(await clients[dispatcherId].call('list_settings'))).toBe(true);
      expect(dispatcher.getDispatcherState().running).toBe(true);
    });

    it('a helper with MCP off keeps message_parent alone', async () => {
      expect(await clients[HELPER].names()).toEqual(['message_parent']);
      expect(await clients[HELPER_OFF].names()).toEqual(['message_parent']);
      for (const name of ['start_helper', 'wake_helper', 'answer_helper_question', 'list_settings', 'notify_user', 'call_wire_tool', 'list_helpers', 'hand_off']) {
        expect(await clients[HELPER].call(name, {}), name).toEqual({ isError: true, text: MCP_OFF_HELPER_TOOL_MESSAGE });
      }
    });

    it('a helper with its own MCP on keeps everything', async () => {
      expect(listed[HELPER_ON]).toEqual(await clients[HELPER_ON].names());
      expect((await clients[HELPER_ON].call('list_settings')).isError).toBe(false);
    });

    it('message_parent to a sleeping parent says so, and wakes nothing', async () => {
      // No runtime is running for the parent yet.
      const before = [...agentRegistry.getAllRegistrations().keys()];
      const result = await clients[HELPER].call('message_parent', { text: 'done' });
      expect(result).toEqual({ isError: true, text: 'conductor is asleep, so the message was not delivered.' });
      expect([...agentRegistry.getAllRegistrations().keys()]).toEqual(before);
    });

    it('message_parent reaches a running parent through its runtime, not its MCP, and takes no other target', async () => {
      const sent = fakeRuntime(ORCH);
      expect(refusedForMcp(await clients[ORCH].call('list_settings'))).toBe(true);
      const result = await clients[HELPER].call('message_parent', { text: 'done', target: PLAIN, agent_id: PLAIN, start: true });
      expect(result.isError).toBe(false);
      await vi.waitFor(() => expect(sent.join()).toContain('[FROM HELPER:runner (durable_helper)] done'));
      expect(sent).toHaveLength(1);
    });

    it('keeps a project with its own setting on, and one kept by Clubhouse mode: orchestration and all', async () => {
      // All but its wires to the Dispatcher, which is off at app level.
      expect(await clients[IN_OVERRIDE].names()).toEqual(expect.arrayContaining(['start_helper', 'list_helpers', 'list_settings']));
      expect((await clients[IN_OVERRIDE].call('list_helpers')).isError).toBe(false);
      expect((await clients[IN_CLUBHOUSE].call('list_settings')).isError).toBe(false);
    });

    it('keeps an agent with its own setting on, whose wire to the Dispatcher is gone', async () => {
      expect((await clients[OWN_MCP].call('list_helpers')).isError).toBe(false);
      expect((await clients[OWN_MCP].names())).toContain('start_helper');
      expect(hasBinding(OWN_MCP, dispatcherId)).toBe(false);
    });

    it('an agent with its own setting off was already closed, and stays closed', async () => {
      expect(refusedForMcp(await clients[OWN_OFF].call('list_settings'))).toBe(true);
    });

    it('an agent with MCP on can still message a running agent with MCP off: the rule is about the caller', async () => {
      const sent = fakeRuntime(PLAIN);
      const send = toolEndingIn(listed[OWN_MCP], 'plain', 'send_message')!;
      const result = await clients[OWN_MCP].call(send, { message: 'from an on agent' });
      expect(result.isError).toBe(false);
      await vi.waitFor(() => expect(sent.join()).toContain('from an on agent'));
      // It can't answer over the wire.
      expect(refusedForMcp(await clients[PLAIN].call(toolEndingIn(listed[ORCH], 'plain', 'get_status')!))).toBe(true);
    });

    it('a message to a dormant agent is refused and wakes nothing', async () => {
      const before = [...agentRegistry.getAllRegistrations().keys()];
      const status = await clients[OWN_MCP].call(toolEndingIn(listed[OWN_MCP], 'peer', 'get_status')!);
      expect(JSON.parse(status.text)).toMatchObject({ status: 'sleeping', running: false });
      const refused = await clients[OWN_MCP].call(toolEndingIn([...listed[OWN_MCP], `clubhouse__${toolEndingIn(listed[OWN_MCP], 'peer', 'get_status')!.split('__')[1]}__send_message`], 'peer', 'send_message')!, { message: 'wake up' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('is sleeping');
      expect([...agentRegistry.getAllRegistrations().keys()]).toEqual(before);
      expect(agentRegistry.get(PEER)).toBeUndefined();
    });

    it('polling: a member that was polling gets one stop, over the real settings and gate', async () => {
      const stops = () => polledSent.filter((m) => m.includes('stop') && m.includes('"looping"'));
      await vi.waitFor(() => expect(stops()).toHaveLength(1), { timeout: 10_000 });
      // Later saves that leave it off send nothing more.
      await save({ enabled: false, projectDefault: true, projectOverrides: { [overridePath]: true } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stops()).toHaveLength(1);
    });

    it('polling: a running member without MCP gets no start and still gets a shoulder tap, and a dormant one stays dormant', async () => {
      const project = await groupProjectRegistry.create('polled');
      polledProject = project.id;
      for (const id of [CODEX, PEER]) bindingManager.bind(id, { targetId: project.id, targetKind: 'group-project', label: 'polled' });
      await setProjectPolling(project.id, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(polledSent.join()).not.toContain('start polling for "polled"');
      const before = [...agentRegistry.getAllRegistrations().keys()];

      await executeShoulderTap({ projectId: project.id, senderLabel: 'the user', targetAgentId: CODEX, message: 'are you there' });
      await vi.waitFor(() => expect(polledSent.join()).toContain('are you there'));
      expect([...agentRegistry.getAllRegistrations().keys()]).toEqual(before);
      expect(agentRegistry.get(PEER)).toBeUndefined();
    });

    it('refuses starting the Dispatcher, at the one place every start goes through', async () => {
      const { spawnAgent } = await import('../../src/main/services/agent-system');
      agentRegistry.untrack(dispatcherId);
      await expect(spawnAgent({
        agentId: dispatcherId, projectPath: dispatcher.getDispatcherPath(), cwd: dispatcher.getDispatcherPath(), kind: 'durable',
      } as never)).rejects.toThrow(MCP_REQUIRED_MESSAGE);
      expect(agentRegistry.get(dispatcherId)).toBeUndefined();
      // Put back for the rest of the walk: it was running when MCP went off.
      await start(dispatcherId, dispatcher.getDispatcherPath());
    });

    it('refuses a policy write that needs MCP with the existing message, and saves nothing', async () => {
      const { setOrchestrationPolicy } = await import('../../src/main/services/orchestration-policy');
      const result = await setOrchestrationPolicy(projectPath, PLAIN, { orchestrate: true });
      expect(result).toMatchObject({ ok: false, message: MCP_REQUIRED_MESSAGE, mcpRequired: true });
      expect((await agentConfig.getDurableConfig(projectPath, PLAIN))?.orchestration).toBeUndefined();
    });

    it('reads a hand edit to agents.json as off too', async () => {
      await agentConfig.setOrchestrationConfig(projectPath, PLAIN, { orchestrate: true });
      expect(await getOrchestrationPolicy(projectPath, PLAIN)).toMatchObject({ orchestrate: false, mcpOff: { orchestrate: true } });
      await agentConfig.setOrchestrationConfig(projectPath, PLAIN, undefined);
    });

    it('an agent\'s own override edited while running moves its gate', async () => {
      await agentConfig.updateDurableConfig(projectPath, PLAIN, { mcpOverride: true });
      await vi.waitFor(async () => expect((await clients[PLAIN].call('list_settings')).isError).toBe(false), { timeout: 10_000 });
      await agentConfig.updateDurableConfig(projectPath, PLAIN, { mcpOverride: null } as never);
      await vi.waitFor(async () => expect(refusedForMcp(await clients[PLAIN].call('list_settings'))).toBe(true), { timeout: 10_000 });
    });

    it('nothing started with MCP off gets a config, and MCP coming back doesn\'t reach back to it', async () => {
      const dir = path.join(A.dir, 'started-off');
      fs.mkdirSync(dir);
      await injectClubhouseMcp(dir, 'durable_late', bridgeServer.getPort(), { mcpConfigFile: '.mcp.json' }, { projectPath });
      expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(false);
    });

    it('a removed connection stays removed while MCP is off', async () => {
      // Removed through the Connections card, which unbinds as the user.
      await A.handlers.get(IPC.MCP_BINDING.UNBIND)!({ sender: {} }, ORCH, REMOVED);
      await vi.waitFor(async () => {
        const store = JSON.parse(await fs.promises.readFile(dispatcherConnectionsPath(), 'utf-8'));
        expect(store.removedByUser.some((r: { targetId: string }) => r.targetId === REMOVED)).toBe(true);
      });
    });

    it('a removed wire made with connect_agents stays removed', async () => {
      await A.handlers.get(IPC.MCP_BINDING.UNBIND)!({ sender: {} }, HELPER2, HELPER);
      await vi.waitFor(async () => {
        const store = JSON.parse(await fs.promises.readFile(connectionsStorePath(projectPath), 'utf-8'));
        expect(store.connections.some((c: { agentId: string }) => c.agentId === HELPER2)).toBe(false);
      });
    });
  });

  describe('with MCP off for one project only', () => {
    beforeAll(async () => {
      await save({ enabled: true, projectDefault: true, projectOverrides: { [projectPath]: false } });
      await saveClubhouseMode({ enabled: false });
    });

    it('refuses that project\'s agents and leaves the rest, the Dispatcher included', async () => {
      expect(refusedForMcp(await clients[ORCH].call('list_settings'))).toBe(true);
      expect((await clients[IN_OVERRIDE].call('list_settings')).isError).toBe(false);
      expect((await clients[dispatcherId].call('list_settings')).isError).toBe(false);
      expect(dispatcher.isDispatcherEnabled()).toBe(true);
    });
  });

  describe('kept on by Clubhouse mode alone', () => {
    it('leaves everyone open, the Dispatcher too, with MCP\'s own switch off', async () => {
      await saveClubhouseMode({ enabled: true });
      await save({ enabled: false, projectDefault: true });
      expect((await clients[ORCH].call('list_settings')).isError).toBe(false);
      expect((await clients[dispatcherId].call('list_settings')).isError).toBe(false);
      await saveClubhouseMode({ enabled: false });
      expect(refusedForMcp(await clients[ORCH].call('list_settings'))).toBe(true);
    });
  });

  describe('with MCP back', () => {
    beforeAll(async () => {
      await save({ enabled: true, projectDefault: true });
      await vi.waitFor(() => {
        expect(hasBinding(ORCH, dispatcherId)).toBe(true);
        expect(hasBinding(ORCH, PEER)).toBe(true);
      }, { timeout: 10_000 });
    }, 30_000);

    it('new calls work in sessions that started with the bridge: no restart, no new session', async () => {
      for (const [label, caller, tool] of everyGroup) {
        if (caller === HELPER && tool.includes('walker')) continue;
        await vi.waitFor(async () => expect(refusedForMcp(await clients[caller].call(tool)), `${label}: ${tool}`).toBe(false), { timeout: 10_000 });
      }
    });

    it('polling: the running member gets its start back, in the same session, and nothing is woken', async () => {
      await vi.waitFor(() => {
        // Never delivered, so it still goes out by itself.
        expect(polledSent.filter((m) => m.includes('start polling for "polled"'))).toHaveLength(1);
      }, { timeout: 10_000 });
      // The loop MCP stopped doesn't restart by itself: its first start only, and it is offered Resume.
      expect(polledSent.filter((m) => m.includes('start polling for "looping"'))).toHaveLength(1);
      expect(listPausedPolling(loopingProject).map((m) => m.agentId)).toEqual([CODEX]);
      expect(await resumePausedPolling(loopingProject, CODEX)).toBe(true);
      expect(polledSent.filter((m) => m.includes('start polling for "looping"'))).toHaveLength(2);
      expect(await resumePausedPolling(loopingProject, CODEX)).toBe(false);
      expect(agentRegistry.get(PEER)).toBeUndefined();
      expect(_pendingStartsForTesting.get(PEER)?.has(polledProject)).toBe(true);
    });

    it('returns the Dispatcher to its saved state, without starting anything new', () => {
      expect(dispatcher.getDispatcherState()).toMatchObject({ enabled: true, savedOn: true, offReason: null });
    });

    it('reopens the gates MCP closed, with the saved orchestration and cross-project helpers', async () => {
      await vi.waitFor(async () => expect(await clients[ORCH].names()).toContain('start_helper'), { timeout: 10_000 });
      expect((await clients[ORCH].call('list_helpers')).isError).toBe(false);
      expect((await clients[ORCH].call('list_projects')).isError).toBe(false);
    });

    it('does not hand orchestration to an agent whose gate was not open', async () => {
      expect((await clients[PLAIN].call('list_helpers')).text).toBe(ORCHESTRATION_OFF_MESSAGE);
    });

    it('rebuilds wires, except the ones the user removed and the agent saved off', async () => {
      expect(hasBinding(REMOVED, dispatcherId)).toBe(true);
      expect(hasBinding(ORCH, REMOVED)).toBe(false);
      expect(hasBinding(HELPER2, HELPER)).toBe(false);
      expect(hasBinding(OTHER_ORCH, dispatcherId)).toBe(false);
    });

    it('wrote no saved value on the way: a prune never saves Connect to Dispatcher', async () => {
      for (const id of [ORCH, PEER, REMOVED, QUITTER]) {
        expect((await agentConfig.getDurableConfig(projectPath, id))?.orchestration?.connectToDispatcher, id).toBeUndefined();
      }
    });

    it('canvas cleanup of a Dispatcher wire keeps it and saves nothing', async () => {
      const result = await A.handlers.get(IPC.MCP_BINDING.UNBIND)!({ sender: {} }, QUITTER, dispatcherId, MCP_UNBIND_CANVAS_CLEANUP);
      expect(result).toEqual({ kept: true });
      expect(hasBinding(QUITTER, dispatcherId)).toBe(true);
      expect((await agentConfig.getDurableConfig(projectPath, QUITTER))?.orchestration?.connectToDispatcher).toBeUndefined();
    });

    it('a user removing a Dispatcher wire saves Connect to Dispatcher off, which survives MCP going off and on', async () => {
      await A.handlers.get(IPC.MCP_BINDING.UNBIND)!({ sender: {} }, QUITTER, dispatcherId);
      await vi.waitFor(async () => expect((await agentConfig.getDurableConfig(projectPath, QUITTER))?.orchestration?.connectToDispatcher).toBe(false));
      await save({ enabled: false, projectDefault: true });
      await vi.waitFor(() => expect(hasBinding(ORCH, dispatcherId)).toBe(false), { timeout: 10_000 });
      await save({ enabled: true, projectDefault: true });
      await vi.waitFor(() => expect(hasBinding(ORCH, dispatcherId)).toBe(true), { timeout: 10_000 });
      expect(hasBinding(QUITTER, dispatcherId)).toBe(false);
    }, 30_000);

    it('applies saved Auto provider again, off while MCP was off', async () => {
      const { setOrchestrationPolicy } = await import('../../src/main/services/orchestration-policy');
      expect((await setOrchestrationPolicy(projectPath, ORCH, { autoHelpers: true })).ok).toBe(true);
      await save({ enabled: false, projectDefault: true });
      expect(await getOrchestrationPolicy(projectPath, ORCH)).toMatchObject({
        autoHelpers: false, autoEffective: { effective: false, reason: 'mcp_off' }, mcpOff: { autoHelpers: true, orchestrate: true, crossProjectHelpers: true, connectToDispatcher: true },
      });
      await save({ enabled: true, projectDefault: true });
      expect(await getOrchestrationPolicy(projectPath, ORCH)).toMatchObject({ autoHelpers: true, autoEffective: { effective: true }, orchestrate: true, crossProjectHelpers: true, connectToDispatcher: true });
      await vi.waitFor(async () => expect(await clients[ORCH].names()).toContain('start_helper'), { timeout: 10_000 });
      await setOrchestrationPolicy(projectPath, ORCH, { autoHelpers: null });
    }, 30_000);

    it('a new run decides its own gate: one started while MCP was off gets none when MCP is back', async () => {
      await save({ enabled: false, projectDefault: true });
      await vi.waitFor(async () => expect(refusedForMcp(await clients[ORCH].call('list_helpers'))).toBe(true), { timeout: 10_000 });
      // What a restart does too: closedByMcp is only in memory, and a start clears it.
      agentRegistry.untrack(ORCH);
      await start(ORCH, projectPath);
      await save({ enabled: true, projectDefault: true });
      await vi.waitFor(() => expect(hasBinding(ORCH, dispatcherId)).toBe(true), { timeout: 10_000 });
      expect((await clients[ORCH].call('list_helpers')).text).toBe(ORCHESTRATION_OFF_MESSAGE);
      // A start with MCP on opens it from the saved policy.
      agentRegistry.untrack(ORCH);
      await start(ORCH, projectPath);
      expect((await clients[ORCH].call('list_helpers')).isError).toBe(false);
    }, 30_000);

    it('keeps every removal across a restart: nothing in memory says it was removed', async () => {
      // What a relaunch starts from: no bindings and no session memory of a removal, only the files.
      _resetPersistedBindingSourcesForTesting();
      _resetDispatcherConnectionsForTesting();
      _resetDispatcherWireSourceForTesting();
      _resetOrchestratorConnectionsForTesting();
      _resetHelperWireSourceForTesting();
      for (const binding of bindingManager.getAllBindings()) bindingManager.unbind(binding.agentId, binding.targetId);
      for (const source of [canvasWireBindingSource, helperWireBindingSource, orchestratorConnectionSource, dispatcherWireBindingSource, dispatcherConnectionSource]) {
        registerPersistedBindingSource(source);
      }
      expect(hasBinding(ORCH, PEER)).toBe(false);
      await rebuildPersistedBindings();
      expect(hasBinding(ORCH, dispatcherId)).toBe(true);
      expect(hasBinding(ORCH, PEER)).toBe(true);
      expect(hasBinding(HELPER, HELPER2)).toBe(true);
      expect(hasBinding(ORCH, REMOVED)).toBe(false);
      expect(hasBinding(HELPER2, HELPER)).toBe(false);
      expect(hasBinding(OTHER_ORCH, dispatcherId)).toBe(false);
      expect(hasBinding(QUITTER, dispatcherId)).toBe(false);
    });

    it('the bridge server never stopped', async () => {
      expect(bridgeServer.getPort()).toBeGreaterThan(0);
      expect((await clients[PLAIN].call('list_settings')).isError).toBe(false);
    });
  });

  describe('what a change would turn off, and what keeps MCP', () => {
    it('names a project that keeps it through its own setting or Clubhouse mode', async () => {
      const impact = await readMcpOffImpact({
        mcp: { enabled: false, projectOverrides: { [overridePath]: true } },
        clubhouseMode: { enabled: false, projectOverrides: { [clubhousePath]: true } },
      });
      expect(impact.appLoses).toBe(true);
      expect(impact.keeps.projects).toEqual([{ name: 'project-override', via: 'project_setting' }, { name: 'project-clubhouse', via: 'clubhouse_mode' }]);
      expect(impact.projectsLosing).toEqual(['project-one']);
      expect(impact.agentsKeeping).toBe(4);
    });

    it('counts a running quick agent the gate would close, by the same rule', async () => {
      agentRegistry.register('quick_one', { projectPath, orchestrator: 'claude-code', runtime: 'pty' } as never);
      setMcpCallerQuick('quick_one', projectPath);
      expect((await readMcpOffImpact({ mcp: { enabled: false } })).quickAgentsLosing).toBe(1);
      expect((await readMcpOffImpact({ mcp: { projectOverrides: { [overridePath]: false } } })).quickAgentsLosing).toBe(0);
      expect((await readMcpOffImpact({ mcp: { enabled: false, projectOverrides: { [projectPath]: true } } })).quickAgentsLosing).toBe(0);
      agentRegistry.untrack('quick_one');
    });

    it('says nothing goes off at app level while Clubhouse mode keeps it on', async () => {
      const impact = await readMcpOffImpact({ mcp: { enabled: false }, clubhouseMode: { enabled: true } });
      expect(impact).toMatchObject({ turnsOff: false, appLoses: false, appKeptByClubhouseMode: true, agentsLosing: 0, dispatcherGoesOff: false });
    });

    it('counts one project losing MCP, and leaves the Dispatcher out of it', async () => {
      const impact = await readMcpOffImpact({ mcp: { projectOverrides: { [projectPath]: false } } });
      expect(impact).toMatchObject({ turnsOff: true, appLoses: false, dispatcherGoesOff: false, projectsLosing: ['project-one'] });
      expect(impact.agentsLosing).toBeGreaterThan(0);
      // A helper with its own setting on is named like any agent; the other three can only report.
      expect(impact.keeps.agents).toEqual([{ name: 'helper-on', project: 'project-one' }, { name: 'own-mcp', project: 'project-one' }]);
      expect(impact.helpersReportOnly).toBe(2);
    });

    it('sees Clubhouse mode going off as MCP going off, where MCP had only that', async () => {
      await save({ enabled: false, projectDefault: true });
      await saveClubhouseMode({ enabled: true });
      const impact = await readMcpOffImpact({ clubhouseMode: { enabled: false } });
      expect(impact).toMatchObject({ turnsOff: true, appLoses: true });
      await saveClubhouseMode({ enabled: false });
      await save({ enabled: true, projectDefault: true });
    });
  });
});
