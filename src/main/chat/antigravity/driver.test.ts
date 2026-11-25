/**
 * The Antigravity ACP driver against the in-memory scripted ACP agent (#3797).
 * The scripted agent is built from the public ACP schema, not from agy: these
 * tests prove the launch spec, the MCP seam and the claims the driver makes,
 * not agy's own behaviour (that is #3802).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { ANTIGRAVITY_CHAT_DRIVER_ID, ANTIGRAVITY_PROVIDER_ID } from '../../../shared/providers/antigravity';
import type { StructuredSpawnCommand } from '../../orchestrators/adapters/structured-spawn';
import { isLoginRequiredError } from '../../services/agent-runtime/login-error';
import { ACP_ERROR_CODES, type InitializeRequest, type SessionConfigOption, type SessionModeState } from '../acp/protocol';
import { ScriptedAcpAgent, type ScriptedAgentOptions } from '../acp/testing/scripted-agent';
import { AntigravityChatStartError, createAntigravityAcpDriver } from './driver';
import { ANTIGRAVITY_LOGIN_HINT, antigravityAcpArgs } from './launch';
import type { AcpStdioMcpServer, AntigravityAcpMcp } from './mcp';

const MODES: SessionModeState = {
  currentModeId: 'default',
  availableModes: [{ id: 'default', name: 'Default' }, { id: 'accept-edits', name: 'Accept edits' }, { id: 'plan', name: 'Plan' }],
};
// Shaped like the documented pickers (Model, Thinking level); the values are made up.
const OPTIONS: SessionConfigOption[] = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] },
  { id: 'thinking', name: 'Thinking level', category: 'thought_level', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high', 'extra', 'max'].map((v) => ({ value: v, name: v })) },
];

const BRIDGE_DEF = { command: 'node', args: ['/app/bridge.js'] };
const START: ChatDriverStartOptions = {
  agentId: 'agent-1',
  provider: ANTIGRAVITY_PROVIDER_ID,
  cwd: '/work/agent-1',
  binaryPath: '/home/me/.local/bin/agy',
  level: 'ask',
  env: { CLUBHOUSE_AGENT_ID: 'agent-1', CLUBHOUSE_HOOK_NONCE: 'nonce-1', CLUBHOUSE_MCP_PORT: '4567' },
  mcpServers: { clubhouse: BRIDGE_DEF, docs: { command: 'docs-mcp', args: [], env: { TOKEN_NAME: 'x' } } },
  mcpHttpEndpoints: { clubhouse: { url: 'http://127.0.0.1:4567/agent-1', headersFromEnv: { 'x-nonce': 'CLUBHOUSE_HOOK_NONCE' } } },
};

/** A stand-in for H2's module: records what it was asked, answers with its documented shapes. */
function fakeMcp(plan?: ReturnType<AntigravityAcpMcp['planAntigravityAcpMcpServers']>) {
  const calls: { bridge: unknown[]; plan: unknown[] } = { bridge: [], plan: [] };
  const mcp: AntigravityAcpMcp = {
    buildAntigravityAcpBridgeServer: (input) => {
      calls.bridge.push(input);
      return { name: 'clubhouse', command: 'node', args: ['/app/bridge.js'], env: [
        { name: 'CLUBHOUSE_AGENT_ID', value: input.agentId },
        { name: 'CLUBHOUSE_HOOK_NONCE', value: input.nonce },
        { name: 'CLUBHOUSE_MCP_PORT', value: String(input.mcpPort) },
      ] };
    },
    planAntigravityAcpMcpServers: (input) => {
      calls.plan.push(input);
      if (plan) return plan;
      const project = Object.entries(input.projectServers ?? {}).map(([name, def]) => {
        const d = def as { command: string; args: string[]; env?: Record<string, string> };
        return { name, command: d.command, args: d.args, env: Object.entries(d.env ?? {}).map(([n, value]) => ({ name: n, value })) } satisfies AcpStdioMcpServer;
      });
      return { ok: true, servers: [input.bridge, ...project], notices: [] };
    },
  };
  return { mcp, calls };
}

async function open(agentOpts: ScriptedAgentOptions = {}, start: Partial<ChatDriverStartOptions> = {}, mcp = fakeMcp()) {
  const agent = new ScriptedAcpAgent({ modes: MODES, configOptions: OPTIONS, ...agentOpts });
  const commands: StructuredSpawnCommand[] = [];
  const driver = createAntigravityAcpDriver({ mcp: mcp.mcp, logDir: '/logs', clientVersion: '1.2.3', connect: (command) => { commands.push(command); return agent.connector; } });
  const session = await driver.start({ ...START, ...start });
  const drafts: ChatEventDraft[] = [];
  void (async () => { for await (const d of session.events) drafts.push(d); })();
  return { agent, driver, session, drafts, commands, calls: mcp.calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('launch', () => {
  it('runs agy acp with a per-launch Clubhouse log file, the caller\'s args after', () => {
    const args = antigravityAcpArgs({ extraArgs: ['--agent', 'x'], level: 'ask' }, { logDir: '/logs' });
    expect(args[0]).toBe('acp');
    expect(args[1]).toBe('--log-file');
    // path.join normalizes separators, so this holds on Windows too.
    expect(path.dirname(args[2])).toBe(path.join('/logs'));
    expect(path.basename(args[2])).toMatch(/^antigravity-acp-\d+-[0-9a-f]{8}\.log$/);
    expect(args.slice(3)).toEqual(['--agent', 'x']);
    expect(antigravityAcpArgs({ extraArgs: [] }, { logDir: '/logs' })[2]).not.toBe(args[2]);
    expect(antigravityAcpArgs({ extraArgs: [] })).toEqual(['acp']);
  });

  it('full access is the launch flag; no other level adds one', () => {
    expect(antigravityAcpArgs({ extraArgs: [], level: 'full_access' })).toEqual(['acp', '--dangerously-skip-permissions']);
    for (const level of ['plan', 'ask', 'auto_edit', 'auto'] as const) expect(antigravityAcpArgs({ extraArgs: [], level })).toEqual(['acp']);
  });

  it('is an opt-in driver for the Antigravity provider, identifying as Clubhouse', async () => {
    const { driver, agent, commands } = await open();
    expect(driver).toMatchObject({ id: ANTIGRAVITY_CHAT_DRIVER_ID, provider: ANTIGRAVITY_PROVIDER_ID });
    // Chat is the primary runtime (#3786): the driver is chosen without a saved preference.
    expect(driver.optIn).toBeFalsy();
    const [init] = agent.sentRequests('initialize') as InitializeRequest[];
    expect(init.clientInfo).toEqual({ name: 'clubhouse', title: 'Clubhouse', version: '1.2.3' });
    expect(commands[0].binary).toBe('/home/me/.local/bin/agy');
    expect(agent.sentRequests('session/new')).toEqual([expect.objectContaining({ cwd: '/work/agent-1' })]);
  });

  // A stubbed platform: proves the spawn resolution, not a native Windows run (#3802 V12).
  it('spawns agy.exe directly on Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { commands } = await open({}, { binaryPath: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe' });
    expect(commands[0]).toMatchObject({ binary: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe', args: expect.arrayContaining(['acp']) });
    expect(commands[0].windowsVerbatimArguments).toBeUndefined();
  });
});

describe('capabilities', () => {
  it('claims the documented behaviour and reads the rest from the session', async () => {
    const { session } = await open();
    expect(session.capabilities).toMatchObject({
      steer: true, queue: 'client', interrupt: true, questions: true,
      modelSwitch: 'live', effortSwitch: 'live',
      liveLevels: ['plan', 'ask', 'auto_edit'],
      login: 'terminal', systemPrompt: false, subagents: 'none',
    });
  });

  it('reports the models and thinking levels exactly as the session offers them', async () => {
    const { drafts } = await open();
    await new Promise((r) => setTimeout(r, 0));
    expect(drafts.find((d) => d.type === 'session_info')?.data).toMatchObject({
      model: 'model-a',
      models: [expect.objectContaining({ id: 'model-a' }), expect.objectContaining({ id: 'model-b' })],
      efforts: ['low', 'medium', 'high', 'extra', 'max'],
    });
  });

  it('a saved model the account is not offered refuses the start, naming it, with no switch to the default', async () => {
    const agent = new ScriptedAcpAgent({ modes: MODES, configOptions: OPTIONS });
    const driver = createAntigravityAcpDriver({ mcp: fakeMcp().mcp, logDir: '/logs', clientVersion: '1.2.3', connect: () => agent.connector });
    const err = await driver.start({ ...START, model: 'model-gone' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'model_unavailable', message: expect.stringContaining('model-gone is not available for this account') });
    expect(agent.received.some((r) => r.method === 'session/set_config_option')).toBe(false);
  });

  it('an offered model the agent then fails to set also refuses the start', async () => {
    const agent = new ScriptedAcpAgent({ modes: MODES, configOptions: OPTIONS, setConfigError: { code: -32603, message: 'quota' } });
    const driver = createAntigravityAcpDriver({ mcp: fakeMcp().mcp, logDir: '/logs', clientVersion: '1.2.3', connect: () => agent.connector });
    const err = await driver.start({ ...START, model: 'model-b' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'model_unavailable', message: expect.stringContaining('model-b is not available for this account') });
  });

  it('with no model option, a saved model doesn\'t refuse the start: it runs on its own model, with a notice', async () => {
    const { session, drafts } = await open({ configOptions: [OPTIONS[1]] }, { model: 'model-a' });
    expect(session).toBeTruthy();
    await vi.waitFor(() => expect(drafts.some((d) => d.type === 'notice' && (d.data as { code?: string }).code === 'model_not_applied')).toBe(true));
  });

  it('switches model and thinking level live', async () => {
    const { session, agent } = await open();
    await session.setModel('model-b', 'high');
    expect(agent.sentRequests('session/set_config_option')).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'model-b' },
      { sessionId: 'session-1', configId: 'thinking', value: 'high' },
    ]);
  });

  // Registration gate 3 (GATE-effort.md): no model id to pass, so effort goes through setEffort.
  it('with no model choice, setModel is refused and setEffort changes the thinking level', async () => {
    const { session, agent } = await open({ configOptions: [OPTIONS[1]] });
    expect(session.capabilities.effortSwitch).toBe('live');
    await expect(session.setModel('', 'high')).rejects.toThrow(/no model choice/);
    await session.setEffort!('high');
    expect(agent.sentRequests('session/set_config_option')).toEqual([{ sessionId: 'session-1', configId: 'thinking', value: 'high' }]);
  });
});

describe('levels', () => {
  it('starts in the mapped mode; Auto is refused, Full access is the launch flag', async () => {
    const plan = await open({}, { level: 'plan' });
    expect(plan.agent.sentRequests('session/set_mode')).toEqual([{ sessionId: 'session-1', modeId: 'plan' }]);
    const edits = await open({}, { level: 'auto_edit' });
    expect(edits.agent.sentRequests('session/set_mode')).toEqual([{ sessionId: 'session-1', modeId: 'accept-edits' }]);
    await expect(open({}, { level: 'auto' })).rejects.toThrow(/no mode for the Auto level/);
    const full = await open({}, { level: 'full_access' });
    expect(full.commands[0].args).toContain('--dangerously-skip-permissions');
    expect(full.session.capabilities.liveLevels).toEqual([]);
  });
});

describe('Clubhouse MCP', () => {
  it('sends the bridge with an explicit environment, over stdio, and no HTTP endpoint', async () => {
    const { agent, calls } = await open();
    expect(calls.bridge).toEqual([{ agentId: 'agent-1', nonce: 'nonce-1', mcpPort: 4567 }]);
    expect(calls.plan).toEqual([expect.objectContaining({ projectServers: { docs: START.mcpServers!.docs }, mcpCapabilities: { http: false, sse: false } })]);
    const [setup] = agent.sentRequests('session/new') as Array<{ mcpServers: unknown[] }>;
    expect(setup.mcpServers).toEqual([
      { name: 'clubhouse', command: 'node', args: ['/app/bridge.js'], env: [
        { name: 'CLUBHOUSE_AGENT_ID', value: 'agent-1' },
        { name: 'CLUBHOUSE_HOOK_NONCE', value: 'nonce-1' },
        { name: 'CLUBHOUSE_MCP_PORT', value: '4567' },
      ] },
      { name: 'docs', command: 'docs-mcp', args: [], env: [{ name: 'TOKEN_NAME', value: 'x' }] },
    ]);
    // Even though the scripted agent would take HTTP if advertised, nothing goes as HTTP.
    expect(JSON.stringify(setup.mcpServers)).not.toContain('127.0.0.1');
  });

  it('refuses the start, launching nothing, without a ready bridge or on a planner refusal', async () => {
    const agent = new ScriptedAcpAgent();
    const connect = vi.fn(() => agent.connector);
    const driver = createAntigravityAcpDriver({ mcp: fakeMcp().mcp, connect });
    await expect(driver.start({ ...START, mcpServers: {} })).rejects.toBeInstanceOf(AntigravityChatStartError);
    await expect(driver.start({ ...START, env: {} })).rejects.toThrow(/bridge is not ready/);
    const refused = createAntigravityAcpDriver({ mcp: fakeMcp({ ok: false, reason: 'A server named clubhouse is configured.' }).mcp, connect });
    await expect(refused.start(START)).rejects.toThrow('A server named clubhouse is configured.');
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('sign-in', () => {
  it('Authentication required at session/new is a login error with agy\'s own sign-in steps', async () => {
    const err = await open({ newSessionError: { code: ACP_ERROR_CODES.authRequired, message: 'Authentication required' } }).catch((e: Error) => e);
    expect((err as Error).message).toBe(`Authentication required: ${ANTIGRAVITY_LOGIN_HINT} (RPC error -32000: Authentication required)`);
    expect(isLoginRequiredError((err as Error).message)).toBe(true);
  });

  it('never calls authenticate', async () => {
    const { agent } = await open({ initialize: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }] } });
    expect(agent.sentRequests('authenticate')).toEqual([]);
  });
});
