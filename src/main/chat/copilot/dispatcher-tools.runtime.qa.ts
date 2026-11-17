/**
 * The Dispatcher's Clubhouse tools on the real Copilot runtime (#3615): the
 * real bridge and tool registrations, the real driver, the runtime npm
 * installs and a local fake model. Same boundary as
 * driver.runtime.qa.ts: run only inside an authorized loopback-only sandbox
 * (docs/copilot-test-boundary.md).
 *
 * A BYOK model gets no tool search unless a session asks for it; hosted models
 * turn it on by their own capability, which no BYOK setting reaches. So the
 * defect is shown with search forced on, and the fix is checked on a driver
 * whose default turns search on below the driver's own settings, as a hosted
 * model's would: without loadAllTools those checks fail. Whether the runtime
 * ranks a real hosted default the same way can't be shown without a login.
 * Set COPILOT_QA_MEASURE_OUT to a file path to record what each request
 * carried.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/log-service', () => ({ appLog: () => undefined }));
vi.mock('../../services/plugin-manifest-registry', () => ({ getManifest: () => ({ permissions: ['mcp.tools'] }) }));
vi.mock('../../services/dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../../services/dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));
vi.mock('../../services/clubhouse-mcp/mcp-call-gate', async (original) => ({
  ...await original<typeof import('../../services/clubhouse-mcp/mcp-call-gate')>(),
  mcpCallAccess: () => 'open',
}));

import type { SessionOptionsBase } from '@microsoft/copilot-sdk';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { COPILOT_OPTION_DENY } from './normalizer';
import { COPILOT_EAGER_TOOL_CEILING, CopilotSdkChatDriver } from './driver';
import { startFakeModel, type FakeModel } from './__fixtures__/fake-model';
import * as bridge from '../../services/clubhouse-mcp/bridge-server';
import { agentRegistry } from '../../services/agent-registry';
import { bindingManager } from '../../services/clubhouse-mcp/binding-manager';
import { registerClubhouseMcpTools } from '../../services/clubhouse-mcp/tools/register-all';
import { getScopedToolList } from '../../services/clubhouse-mcp/tool-registry';
import { setMcpCaller } from '../../services/clubhouse-mcp/mcp-call-gate';
import { setDispatcherAgent, setDispatcherChatAgent } from '../../services/clubhouse-mcp/dispatcher-gate';

const platform = `${process.platform}-${process.arch}`;
const runtime = path.resolve(__dirname, '../../../../node_modules/@microsoft', `copilot-sdk-${platform}`, 'prebuilds', platform, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'copilot-controller-'));
const PROJECT = path.join(tmp, 'project');
fs.mkdirSync(PROJECT, { recursive: true });
const invalid = 'invalid-test-token';
const SEARCH_ON: Partial<SessionOptionsBase> = { tools: { search: { enabled: true } } };
/** A driver whose sessions search by default, as a hosted model's do. */
const hosted = () => new CopilotSdkChatDriver({ sessionDefaults: SEARCH_ON });
/** How the runtime names a Clubhouse tool to the model. */
const modelName = (tool: string) => `clubhouse-${tool}`;

function watch(session: ChatDriverSession) {
  const drafts: ChatEventDraft[] = [];
  void (async () => { for await (const d of session.events) drafts.push(d); })();
  const of = <K extends ChatEventDraft['type']>(type: K) => drafts.filter((d) => d.type === type) as Array<Extract<ChatEventDraft, { type: K }>>;
  const until = async <T>(fn: () => T | undefined, ms = 45_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`Timed out. Saw: ${drafts.map((d) => d.type).join(' ')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const endedTurns = (n: number) => until(() => (of('turn_ended').length >= n ? true : undefined));
  return { of, until, endedTurns };
}

const measured: Record<string, unknown> = {};

describe('the Dispatcher\'s tools on the real runtime (#3615)', () => {
  let model: FakeModel;
  let port: number;
  const sessions: ChatDriverSession[] = [];

  beforeAll(async () => {
    if (!fs.existsSync(runtime)) throw new Error('Copilot runtime is missing; install the platform package before running QA');
    model = await startFakeModel();
    registerClubhouseMcpTools();
    for (const [id, nonce] of [['dispatcher', 'dispatcher-nonce'], ['chat', 'chat-nonce']]) {
      agentRegistry.register(id, { projectPath: PROJECT, orchestrator: 'copilot-cli', runtime: 'chat', nonce });
      setMcpCaller(id, PROJECT, {});
    }
    setDispatcherAgent('dispatcher', true);
    setDispatcherChatAgent('chat', true);
    bindingManager.bind('dispatcher', { targetId: 'worker', targetKind: 'agent', label: 'worker', targetName: 'worker' });
    port = await bridge.start();
  });
  afterEach(async () => {
    model.reset();
    agentRegistry.untrack('worker');
    await Promise.all(sessions.splice(0).map((s) => s.close()));
  });
  afterAll(() => {
    bridge.stop();
    model.close();
    if (process.env.COPILOT_QA_MEASURE_OUT) fs.writeFileSync(process.env.COPILOT_QA_MEASURE_OUT, JSON.stringify(measured, null, 2));
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the CLI can still be flushing logs */ }
  });

  /** A connected agent waking or sleeping: the bridge tells the coordinator its list changed. */
  const wake = () => {
    agentRegistry.register('worker', { projectPath: PROJECT, orchestrator: 'copilot-cli', runtime: 'chat', nonce: 'worker-nonce' });
    agentRegistry.setNonce('worker', 'worker-nonce-2');
  };
  const sleep = () => agentRegistry.untrack('worker');
  const bridgeNames = (agentId = 'dispatcher') => getScopedToolList(agentId).map((t) => modelName(t.name)).sort();

  const options = (overrides: Partial<ChatDriverStartOptions> = {}, agentId = 'dispatcher'): ChatDriverStartOptions => ({
    agentId, provider: 'copilot-cli', cwd: PROJECT, binaryPath: runtime, level: 'full_access',
    env: {
      HOME: tmp, USERPROFILE: tmp, COPILOT_HOME: path.join(tmp, '.copilot'), XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_STATE_HOME: path.join(tmp, 'state'),
      COPILOT_GITHUB_TOKEN: invalid, GH_TOKEN: invalid, GITHUB_TOKEN: invalid,
      COPILOT_PROVIDER_BASE_URL: model.baseUrl, COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'fake-key', COPILOT_MODEL: 'fake-model',
      CLUBHOUSE_NONCE: agentId === 'chat' ? 'chat-nonce' : 'dispatcher-nonce',
    },
    extraArgs: ['--no-auto-login'],
    mcpServers: { clubhouse: { command: 'unused' } },
    mcpHttpEndpoints: { clubhouse: { url: bridge.agentEndpointUrl(port, agentId), headersFromEnv: { [bridge.NONCE_HEADER]: 'CLUBHOUSE_NONCE' } } },
    ...overrides,
  });

  const open = async (driver: CopilotSdkChatDriver, overrides?: Partial<ChatDriverStartOptions>, agentId?: string) => {
    const session = await driver.start(options(overrides, agentId));
    sessions.push(session);
    const w = watch(session);
    let turns = 0;
    /** One turn; returns the tools its first model request offered. */
    const turn = async (text: string, ...steps: Parameters<FakeModel['script']>) => {
      const before = model.tools.length;
      model.script(...(steps.length ? steps : [{ text: 'ok' }]));
      await session.send([{ type: 'text', text }], 'prompt');
      await w.endedTurns(++turns);
      return { offered: [...(model.tools[before] ?? [])].sort(), defs: model.toolDefs[before] ?? [] };
    };
    const close = async () => {
      await session.close();
      sessions.splice(sessions.indexOf(session), 1);
    };
    // The runtime connects MCP servers as the session starts.
    await new Promise((r) => setTimeout(r, 1_500));
    return { session, ...w, turn, close };
  };

  /** What tool_search_tool told the model last, from the request that carried the result. */
  const searchResult = () => {
    const messages = JSON.parse(model.requests.at(-1)?.text ?? '[]') as Array<{ role: string; content: unknown }>;
    const content = messages.filter((m) => m.role === 'tool').at(-1)?.content;
    return typeof content === 'string' ? content : JSON.stringify(content ?? '');
  };
  const search = (query: string) => [{ tools: [{ name: 'tool_search_tool', args: { query } }] }, { text: 'ok' }] as const;
  const listed = (result: string, tool: string) => result.includes(`- ${modelName(tool)}:`);
  const bytes = (defs: unknown[], clubhouseOnly = false) =>
    JSON.stringify(clubhouseOnly ? defs.filter((d) => (d as { function?: { name?: string } }).function?.name?.startsWith('clubhouse-')) : defs).length;

  it('shows the defect it avoids: with tool search on, a search leaves out a loaded tool, before and after a resume', async () => {
    const driver = new CopilotSdkChatDriver({ sessionOverrides: SEARCH_ON });
    const first = await open(driver);
    const start = await first.turn('hi');
    expect(start.offered).toContain('tool_search_tool');
    expect(start.offered.filter((n) => n.startsWith('clubhouse-'))).toEqual([]);
    measured.searchOnStart = { tools: start.offered.length, bytes: bytes(start.defs) };

    await first.turn('find it', ...search('create_managed_agent'));
    expect(listed(searchResult(), 'create_managed_agent')).toBe(true);
    const again = await first.turn('find it again', ...search('create_managed_agent'));
    // Loaded, offered and callable, yet the search doesn't list it.
    expect(again.offered).toContain(modelName('create_managed_agent'));
    expect(listed(searchResult(), 'create_managed_agent')).toBe(false);

    const id = first.session.nativeSessionId;
    await first.close();
    const resumed = await open(driver, { resumeNativeSessionId: id });
    expect(resumed.session.resumeFallback).toBeUndefined();
    const after = await resumed.turn('find it after the resume', ...search('create_managed_agent'));
    expect(after.offered).toContain(modelName('create_managed_agent'));
    expect(listed(searchResult(), 'create_managed_agent')).toBe(false);
    measured.searchOnAfterTwoSearches = { tools: after.offered.length, bytes: bytes(after.defs), clubhouseBytes: bytes(after.defs, true) };
  }, 180_000);

  it('offers the Dispatcher every bridge tool at start, after a wake and a sleep, and calls one of each kind', async () => {
    const s = await open(hosted(), { loadAllTools: true });
    const asleep = await s.turn('hi');
    expect(asleep.offered).not.toContain('tool_search_tool');
    expect(asleep.offered.filter((n) => n.startsWith('clubhouse-'))).toEqual(bridgeNames());
    expect(asleep.offered).toContain(modelName('create_managed_agent'));
    expect(asleep.offered.some((n) => n.endsWith('__wake_agent'))).toBe(true);
    expect(asleep.offered.length).toBeLessThanOrEqual(COPILOT_EAGER_TOOL_CEILING);
    measured.allToolsAsleep = { tools: asleep.offered.length, clubhouseTools: bridgeNames().length, bytes: bytes(asleep.defs), clubhouseBytes: bytes(asleep.defs, true) };

    const global = modelName('list_settings');
    await s.turn('call a global tool', { tools: [{ name: global }] }, { text: 'ok' });
    expect(s.of('tool_call_update').some((u) => u.data.status === 'completed' && JSON.stringify(u.data.content).length > 2)).toBe(true);

    wake();
    await new Promise((r) => setTimeout(r, 1_000));
    const awake = await s.turn('woke');
    expect(awake.offered.filter((n) => n.startsWith('clubhouse-'))).toEqual(bridgeNames());
    expect(awake.offered.some((n) => n.endsWith('__send_message'))).toBe(true);
    expect(awake.offered.some((n) => n.endsWith('__sleep_agent'))).toBe(true);
    expect(awake.offered.length).toBeLessThanOrEqual(COPILOT_EAGER_TOOL_CEILING);
    measured.allToolsAwake = { tools: awake.offered.length, clubhouseTools: bridgeNames().length, bytes: bytes(awake.defs), clubhouseBytes: bytes(awake.defs, true) };

    const status = awake.offered.find((n) => n.endsWith('__get_status'))!;
    const completed = s.of('tool_call_update').filter((u) => u.data.status === 'completed').length;
    await s.turn('call a wire tool', { tools: [{ name: status }] }, { text: 'ok' });
    expect(s.of('tool_call_update').filter((u) => u.data.status === 'completed').length).toBeGreaterThan(completed);

    sleep();
    await new Promise((r) => setTimeout(r, 1_000));
    const slept = await s.turn('slept');
    expect(slept.offered.filter((n) => n.startsWith('clubhouse-'))).toEqual(bridgeNames());
    expect(slept.offered.some((n) => n.endsWith('__send_message'))).toBe(false);
  }, 180_000);

  it('keeps every tool after a resume and after a compaction', async () => {
    const driver = hosted();
    const first = await open(driver, { loadAllTools: true });
    await first.turn('hi');
    const id = first.session.nativeSessionId;
    await first.close();
    const resumed = await open(driver, { loadAllTools: true, resumeNativeSessionId: id });
    expect(resumed.session.resumeFallback).toBeUndefined();
    expect((await resumed.turn('resumed')).offered.filter((n) => n.startsWith('clubhouse-'))).toEqual(bridgeNames());
    await resumed.session.compact();
    await resumed.until(() => resumed.of('notice').find((n) => n.data.code === 'compacted'));
    const compacted = await resumed.turn('after compaction');
    expect(compacted.offered).not.toContain('tool_search_tool');
    expect(compacted.offered.filter((n) => n.startsWith('clubhouse-'))).toEqual(bridgeNames());
  }, 180_000);

  it('offers every tool when a session that searched before the fix resumes on it', async () => {
    const before = await open(new CopilotSdkChatDriver({ sessionOverrides: SEARCH_ON }));
    await before.turn('hi');
    await before.turn('find it', ...search('create_managed_agent'));
    const id = before.session.nativeSessionId;
    await before.close();
    const after = await open(hosted(), { loadAllTools: true, resumeNativeSessionId: id });
    expect(after.session.resumeFallback).toBeUndefined();
    const offered = (await after.turn('resumed on the fix')).offered;
    expect(offered).not.toContain('tool_search_tool');
    expect(offered.filter((n) => n.startsWith('clubhouse-'))).toEqual(bridgeNames());
  }, 180_000);

  it.each([
    ['every tool up front on a searching driver', true],
    ['no search on a BYOK driver, as before the fix', false],
  ] as const)('asks before a Clubhouse tool that changes things runs at Ask, and a denial stops it: %s', async (_how, loadAllTools) => {
    const s = await open(loadAllTools ? hosted() : new CopilotSdkChatDriver(), { loadAllTools, level: 'ask' });
    await s.turn('hi');
    model.script({ tools: [{ name: modelName('write_memory'), args: { path: 'qa.md', content: 'never written' } }] }, { text: 'ok' });
    await s.session.send([{ type: 'text', text: 'call it' }], 'prompt');
    const request = await s.until(() => s.of('permission_request')[0]);
    expect(request.data.toolName).toContain('write_memory');
    await s.session.respondPermission(request.data.requestId, COPILOT_OPTION_DENY);
    await s.endedTurns(2);
    expect(s.of('permission_resolved')[0].data.decision).toBe('deny');
    expect(s.of('tool_call_update').some((u) => u.data.status === 'failed')).toBe(true);
  }, 180_000);

  it('shows the Dispatcher chat hits the same defect: its 16 tools go behind search, and a second search leaves out start_work', async () => {
    const s = await open(new CopilotSdkChatDriver({ sessionOverrides: SEARCH_ON }), {}, 'chat');
    const start = await s.turn('hi');
    expect(bridgeNames('chat')).toContain(modelName('start_work'));
    expect(start.offered.filter((n) => n.startsWith('clubhouse-'))).toEqual([]);
    await s.turn('find it', ...search('start_work'));
    expect(listed(searchResult(), 'start_work')).toBe(true);
    const again = await s.turn('find it again', ...search('start_work'));
    expect(again.offered).toContain(modelName('start_work'));
    expect(listed(searchResult(), 'start_work')).toBe(false);
  }, 180_000);

  it('offers the Dispatcher chat every bridge tool with every tool up front', async () => {
    const s = await open(hosted(), { loadAllTools: true }, 'chat');
    const start = await s.turn('hi');
    expect(start.offered).not.toContain('tool_search_tool');
    expect(start.offered.filter((n) => n.startsWith('clubhouse-'))).toEqual(bridgeNames('chat'));
    measured.chatAllTools = { tools: start.offered.length, clubhouseTools: bridgeNames('chat').length, bytes: bytes(start.defs), clubhouseBytes: bytes(start.defs, true) };
  }, 180_000);

  describe('at the ceiling', () => {
    /**
     * A stdio MCP server with `n` tools, and a searching session on it that loads
     * every tool. A call to any of its tools adds `grow` more and says the list changed.
     */
    const onServer = async (n: number, grow = 0) => {
      const script = path.join(tmp, `server-${n}-${grow}.js`);
      fs.writeFileSync(script, `
        const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        const tool = (i) => ({ name: 'probe_' + String(i).padStart(3, '0'), description: 'probe tool number ' + i, inputSchema: { type: 'object', properties: {} } });
        let count = ${n};
        require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
          const m = JSON.parse(line);
          const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
          if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'many', version: '1' } });
          if (m.method === 'tools/list') return reply({ tools: Array.from({ length: count }, (_, i) => tool(i)) });
          if (m.method === 'tools/call') { count += ${grow}; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); return reply({ content: [{ type: 'text', text: 'grew' }] }); }
          if (m.id !== undefined) reply({});
        });
      `);
      const warnings: Array<Record<string, unknown> | undefined> = [];
      const driver = new CopilotSdkChatDriver({ sessionDefaults: SEARCH_ON, log: (level, message, meta) => { if (level === 'warn' && message.includes('ceiling')) warnings.push(meta); } });
      const s = await open(driver, { loadAllTools: true, mcpServers: { many: { command: process.execPath, args: [script] } }, mcpHttpEndpoints: undefined });
      return { ...s, warnings };
    };
    /** The CLI's own tools, which count toward the ceiling. */
    const ownTools = async () => (await (await open(hosted(), { loadAllTools: true, mcpServers: undefined, mcpHttpEndpoints: undefined })).turn('hi')).offered.length;
    const probes = (offered: string[]) => offered.filter((t) => t.includes('probe_'));
    /** Lets the driver's after-turn count land before a check that nothing was logged. */
    const settle = () => new Promise((r) => setTimeout(r, 500));

    it.each([['one under', -1], ['exactly at', 0]] as const)('loads every tool, with nothing logged, %s the ceiling', async (_where, offset) => {
      const total = COPILOT_EAGER_TOOL_CEILING + offset;
      const n = total - await ownTools();
      const s = await onServer(n);
      const offered = (await s.turn('hi')).offered;
      expect(offered).toHaveLength(total);
      expect(offered).not.toContain('tool_search_tool');
      expect(probes(offered)).toHaveLength(n);
      await settle();
      expect(s.warnings).toEqual([]);
    }, 180_000);

    it('falls back to the runtime\'s search one tool over: every MCP tool deferred and searchable, as before the fix, and says so once', async () => {
      const n = COPILOT_EAGER_TOOL_CEILING + 1 - await ownTools();
      const s = await onServer(n);
      const offered = (await s.turn('hi')).offered;
      await s.until(() => s.warnings[0]);
      expect(s.warnings).toEqual([{ agentId: 'dispatcher', total: COPILOT_EAGER_TOOL_CEILING + 1, ceiling: COPILOT_EAGER_TOOL_CEILING }]);
      expect(offered).toContain('tool_search_tool');
      expect(probes(offered)).toEqual([]);
      const found = await s.turn('find it', ...search('probe tool number 42'));
      expect(searchResult()).toContain('probe_042');
      expect(found.offered.some((t) => t.includes('probe_042'))).toBe(false);
      expect((await s.turn('next')).offered.some((t) => t.includes('probe_042'))).toBe(true);
      await settle();
      expect(s.warnings).toHaveLength(1);
    }, 180_000);

    it('falls back to the runtime\'s search the turn after the catalog grows past the ceiling mid-session, and says so once', async () => {
      // A wake adds about 7 tools; three cross from one under.
      const n = COPILOT_EAGER_TOOL_CEILING - 1 - await ownTools();
      const s = await onServer(n, 3);
      const before = (await s.turn('hi')).offered;
      expect(before).toHaveLength(COPILOT_EAGER_TOOL_CEILING - 1);
      await settle();
      expect(s.warnings).toEqual([]);
      await s.turn('grow', { tools: [{ name: before.find((t) => t.includes('probe_000'))! }] }, { text: 'ok' });
      expect(s.of('tool_call_update').some((u) => JSON.stringify(u.data.content).includes('grew'))).toBe(true);
      await new Promise((r) => setTimeout(r, 1_000));
      // The runtime re-counts on the list change and defers every MCP tool, the one just called included.
      const after = (await s.turn('after')).offered;
      expect(after).toContain('tool_search_tool');
      expect(probes(after)).toEqual([]);
      await s.until(() => s.warnings[0]);
      expect(s.warnings).toEqual([{ agentId: 'dispatcher', total: COPILOT_EAGER_TOOL_CEILING + 2, ceiling: COPILOT_EAGER_TOOL_CEILING }]);
      expect(probes((await s.turn('later')).offered)).toEqual([]);
      await settle();
      expect(s.warnings).toHaveLength(1);
    }, 180_000);
  });
});
