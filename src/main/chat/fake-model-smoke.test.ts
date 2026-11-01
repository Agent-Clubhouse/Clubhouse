/**
 * The Dispatcher flow against REAL installed CLIs and a FAKE model endpoint:
 * real CLI, real chat driver, real MCP bridge and tools; the model and the
 * wired agents are stand-ins. No request can reach a paid model: the CLI gets
 * a temp home, a made-up key and a base URL on 127.0.0.1.
 *
 * Skipped unless CLUBHOUSE_FAKE_MODEL_SMOKE=1.
 *   CLUBHOUSE_FAKE_MODEL_BIN_DIR    folder holding the CLI binaries under test
 *   CLUBHOUSE_FAKE_MODEL_PROVIDERS  comma list of provider ids (default: all three)
 *   CLUBHOUSE_FAKE_MODEL_REPORT     write a JSON report here
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatDriver, ChatDriverSession } from '../../shared/chat';
import { startFakeModelServer, type FakeModelServer } from './testing/fake-model-server';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(os.tmpdir(), `clubhouse-fake-model-${name}`), getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
}));

// The login shell's env holds the user's real keys; the CLI gets none of it.
vi.mock('../util/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../util/shell')>()),
  getShellEnvironment: () => ({ PATH: process.env.PATH ?? '', USER: 'fake', SHELL: '/bin/sh' }),
}));

const sent = vi.hoisted(() => [] as Array<{ target: string; text: string }>);
vi.mock('../services/agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/agent-runtime')>()),
  getAgentRuntime: (id: string) => ({
    kind: 'pty',
    isRunning: () => true,
    sendMessage: async (text: string) => { sent.push({ target: id, text }); return { delivery: 'prompt' }; },
    readTranscript: async () => ({ text: `OUTPUT_OF_${id}` }),
  }),
}));

import { ClaudeChatDriver } from './claude';
import { CopilotSdkChatDriver } from './copilot/driver';
import { getProvider, registerBuiltinProviders, type OrchestratorId } from '../orchestrators';
import { CodexChatDriver } from '../orchestrators/adapters/codex-chat-driver';
import { createCopilotAcpChatDriver } from '../orchestrators/adapters/acp-chat-driver';
import { agentRegistry } from '../services/agent-registry';
import { evaluateCliVersion } from '../services/agent-runtime/chat-version-policy';
import { bindingManager } from '../services/clubhouse-mcp/binding-manager';
import * as bridgeServer from '../services/clubhouse-mcp/bridge-server';
import { CLUBHOUSE_BRIDGE_ENV_VARS } from '../services/clubhouse-mcp/injection';
import { registerAgentTools } from '../services/clubhouse-mcp/tools/agent-tools';

const enabled = process.env.CLUBHOUSE_FAKE_MODEL_SMOKE === '1';
const TURN_TIMEOUT_MS = 90_000;
const SELF = 'fake-dispatcher';
const NONCE_HEADER = bridgeServer.NONCE_HEADER;
const BRIDGE_SCRIPT = path.join(__dirname, '../services/clubhouse-mcp/bridge/clubhouse-mcp-bridge.js');

interface Step { step: string; tools: string[]; called?: string; toolResults: string[]; prompt: string }
const report: Record<string, unknown>[] = [];

function binary(name: string): string {
  const dir = process.env.CLUBHOUSE_FAKE_MODEL_BIN_DIR;
  if (!dir) throw new Error('Set CLUBHOUSE_FAKE_MODEL_BIN_DIR');
  return path.join(dir, name);
}

/** A running chat session with its events collected, driven a turn at a time. */
class Driven {
  readonly events: Array<{ type: string; data?: any }> = [];
  private done: Promise<void>;
  constructor(readonly session: ChatDriverSession) {
    this.done = (async () => {
      for await (const ev of session.events) {
        this.events.push(ev as { type: string; data?: any });
        if ((ev as { type: string }).type === 'permission_request') {
          const data = (ev as { data: any }).data;
          void session.respondPermission(data.requestId, data.options?.[0]?.optionId ?? data.options?.[0]?.id ?? 'allow');
        }
      }
    })();
  }
  turnsEnded(): number { return this.events.filter((e) => e.type === 'turn_ended').length; }
  async turn(text: string): Promise<void> {
    const before = this.turnsEnded();
    await this.session.send([{ type: 'text', text }], 'prompt');
    await vi.waitFor(() => expect(this.turnsEnded()).toBeGreaterThan(before), { timeout: TURN_TIMEOUT_MS, interval: 100 });
  }
  async close(): Promise<void> {
    await this.session.close();
    await this.done;
  }
}

describe.skipIf(!enabled)('Dispatcher flow (real CLI, fake model)', () => {
  let model: FakeModelServer;
  let root: string;
  let port: number;

  beforeAll(async () => {
    registerBuiltinProviders();
    registerAgentTools();
    port = await bridgeServer.start();
    model = await startFakeModelServer();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-model-smoke-')));
  });

  afterAll(async () => {
    bridgeServer.stop();
    await model?.close();
    const out = process.env.CLUBHOUSE_FAKE_MODEL_REPORT;
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
    // A CLI can still be writing its session files as it exits.
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  function claudeEnv(home: string): Record<string, string> {
    return {
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_BASE_URL: model.url,
      ANTHROPIC_API_KEY: 'fake-key-for-a-local-server',
      ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      DISABLE_AUTOUPDATER: '1',
      // Puts MCP tools in each request's tools[], where the fake model can see and call them.
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
  }

  /** Codex takes its provider from config.toml, so the temp CODEX_HOME is the whole setup. */
  function codexEnv(home: string): Record<string, string> {
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model = "gpt-fake-1"',
      'model_provider = "fake"',
      '[model_providers.fake]',
      'name = "fake"',
      `base_url = "${model.url}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      '',
    ].join('\n'));
    return { HOME: home, CODEX_HOME: codexHome, OPENAI_API_KEY: 'fake-key-for-a-local-server', CODEX_API_KEY: '' };
  }

  /** Invalid GitHub tokens, so Copilot can't fall back to a paid request. */
  function copilotEnv(home: string): Record<string, string> {
    return {
      HOME: home,
      COPILOT_HOME: path.join(home, '.copilot'),
      // Skips GitHub auth, telemetry and auto-update, so the local provider is all it can reach.
      COPILOT_OFFLINE: 'true',
      COPILOT_PROVIDER_BASE_URL: `${model.url}/v1`,
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: 'fake-key-for-a-local-server',
      COPILOT_MODEL: 'gpt-fake-1',
      COPILOT_GITHUB_TOKEN: 'invalid',
      GH_TOKEN: 'invalid',
      GITHUB_TOKEN: 'invalid',
    };
  }

  const drivers: Array<{ driver: () => ChatDriver; provider: OrchestratorId; bin: string; env: (home: string) => Record<string, string> }> = [
    { driver: () => new ClaudeChatDriver('claude_agent_sdk'), provider: 'claude-code', bin: 'claude', env: claudeEnv },
    { driver: () => new ClaudeChatDriver('claude_stream_json'), provider: 'claude-code', bin: 'claude', env: claudeEnv },
    { driver: () => new CodexChatDriver(), provider: 'codex-cli', bin: 'codex', env: codexEnv },
    { driver: () => createCopilotAcpChatDriver(), provider: 'copilot-cli', bin: 'copilot', env: copilotEnv },
    // A headless Copilot ignores COPILOT_PROVIDER_*, so the provider goes in the session config.
    { driver: () => new CopilotSdkChatDriver({ sessionOverrides: { model: 'gpt-fake-1', provider: { type: 'openai', baseUrl: `${model?.url}/v1`, apiKey: 'fake-key-for-a-local-server' } } }), provider: 'copilot-cli', bin: 'copilot', env: copilotEnv },
  ];

  const only = process.env.CLUBHOUSE_FAKE_MODEL_PROVIDERS?.split(',').map((p) => p.trim());
  for (const { driver: make, provider, bin, env } of drivers.filter((d) => !only || only.includes(d.provider))) {
    it(`${provider} / ${make().id}: wake, send_message, read_output, sleep, new wire, resume`, async () => {
      // Made here, not above: a driver's settings can read the running fake model.
      const driver = make();
      const home = fs.mkdtempSync(path.join(root, 'home-'));
      const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
      const self = `${SELF}-${driver.id}`;
      const alpha = `alpha_${driver.id}`;
      const beta = `beta_${driver.id}`;
      const nonce = `nonce-${driver.id}`;
      const orchestrator = provider;
      agentRegistry.register(self, { projectPath: cwd, cwd, orchestrator, runtime: 'chat', nonce });
      agentRegistry.register(alpha, { projectPath: cwd, orchestrator, runtime: 'pty' });
      bindingManager.bind(self, { targetId: alpha, targetKind: 'agent', label: alpha, targetName: alpha, projectName: 'fake' });
      model.requests.length = 0;
      const steps: Step[] = [];
      const start = (resumeNativeSessionId?: string) => driver.start({
        agentId: self,
        provider,
        cwd,
        binaryPath: binary(bin),
        level: 'full_access',
        // Copilot takes its model from COPILOT_MODEL.
        ...(provider !== 'copilot-cli' && { model: provider === 'claude-code' ? 'claude-fake-1' : 'gpt-fake-1' }),
        env: { ...spawnEnv, CLUBHOUSE_AGENT_ID: self, CLUBHOUSE_HOOK_NONCE: nonce, CLUBHOUSE_MCP_PORT: String(port) },
        mcpServers: { clubhouse: { type: 'stdio', command: process.execPath, args: [BRIDGE_SCRIPT], env: {}, env_vars: CLUBHOUSE_BRIDGE_ENV_VARS } },
        mcpHttpEndpoints: { clubhouse: { url: bridgeServer.agentEndpointUrl(port, self), headersFromEnv: { [NONCE_HEADER]: 'CLUBHOUSE_HOOK_NONCE' } } },
        ...(resumeNativeSessionId && { resumeNativeSessionId }),
      });
      const mark = (step: string) => {
        const r = model.requests.filter((q) => q.tools.length > 0).at(-1);
        const callers = model.requests.filter((q) => q.called).at(-1);
        steps.push({ step, tools: r?.tools.filter((t) => t.includes('clubhouse')) ?? [], called: callers?.called, toolResults: r?.toolResults ?? [], prompt: (r?.prompt ?? '').slice(0, 200) });
      };
      const row: Record<string, unknown> = { provider, driver: driver.id, steps };
      report.push(row);

      const spawnEnv = { PATH: process.env.PATH ?? '', USER: 'fake', ...env(home) };
      const probe = await driver.probe(binary(bin), spawnEnv);
      expect(probe.handshakeOk).toBe(true);
      row.cliVersion = probe.cliVersion;
      row.versionStatus = evaluateCliVersion(driver.id, provider, probe.cliVersion).status;

      let chat = new Driven(await start());
      const seenUnknown: unknown[] = [];
      const unknownProtocol = () => [...seenUnknown, ...chat.events.filter((e) => e.type === 'protocol_unknown').map((e) => e.data)];
      try {
        // Wake with a message: the first prompt reaches the model and calls a wire.
        await chat.turn(`FAKE_CALL:${alpha}:send_message:{"message":"HELLO_FROM_WAKE"}`);
        mark('wake+send_message');
        await vi.waitFor(() => expect(sent.some((s) => s.target === alpha && s.text.includes('HELLO_FROM_WAKE'))).toBe(true), { timeout: 5_000 });

        await chat.turn(`FAKE_CALL:${alpha}:read_output`);
        mark('read_output');
        expect(model.requests.some((q) => q.toolResults.some((t) => t.includes(`OUTPUT_OF_${alpha}`)))).toBe(true);

        // Sleep: the target leaves the registry. Recorded, not asserted: Codex keeps
        // every wire tool on purpose, and Claude Code with tool search off keeps offering them.
        agentRegistry.untrack(alpha);
        await new Promise((r) => setTimeout(r, 1_500));
        await chat.turn('after target sleep');
        mark('target asleep');
        const asleep = model.requests.filter((q) => q.tools.length > 0).at(-1)!.tools;
        row.toolsDroppedOnSleep = !asleep.some((t) => t.includes(alpha) && t.endsWith('__send_message'));

        // A wire added mid-session is callable on the next turn.
        agentRegistry.register(beta, { projectPath: cwd, orchestrator, runtime: 'pty' });
        bindingManager.bind(self, { targetId: beta, targetKind: 'agent', label: beta, targetName: beta, projectName: 'fake' });
        await new Promise((r) => setTimeout(r, 1_500));
        await chat.turn(`FAKE_CALL:${beta}:send_message:{"message":"HELLO_NEW_WIRE"}`);
        mark('wire added');
        // tools/list_changed: a CLI that honors it offers the new wire's tools, and
        // ignoresToolListChanged has to agree with what this version really did.
        const reached = () => sent.some((s) => s.target === beta && s.text.includes('HELLO_NEW_WIRE'));
        row.newWireReachedModel = reached();
        expect(row.newWireReachedModel).toBe(!getProvider(provider)!.getCapabilities().ignoresToolListChanged);
        if (!reached()) {
          await chat.turn(`FAKE_CALL:call_wire_tool:call_wire_tool:{"target":"${beta}","tool":"send_message","arguments":{"message":"HELLO_NEW_WIRE"}}`);
          mark('wire added, call_wire_tool');
          expect(reached()).toBe(true);
        }

        // Sleep this session, then wake it with a message on the same native session.
        const nativeId = chat.events.filter((e) => e.type === 'session_info').map((e) => e.data?.nativeSessionId).filter(Boolean).at(-1) ?? chat.session.nativeSessionId;
        expect(nativeId).toBeTruthy();
        await chat.close();
        seenUnknown.push(...unknownProtocol());
        chat = new Driven(await start(nativeId));
        await chat.turn('wake again');
        mark('resumed');
        expect(model.requests.at(-1)?.body).toContain('OUTPUT_OF_');
        row.afterResume = model.requests.filter((q) => q.tools.length > 0).at(-1)!.tools.filter((t) => t.includes('clubhouse')).map((t) => t.split('fake_')[1]);
        row.resumed = true;

        row.unknownProtocol = unknownProtocol();
        expect(row.unknownProtocol).toEqual([]);
        row.unhandled = [...new Set(model.unhandled)];
        row.requests = model.requests.length;
      } finally {
        await chat.close().catch(() => {});
        row.errors = chat.events.filter((e) => e.type === 'error').map((e) => e.data);
        bindingManager.unbindAgent(self);
        agentRegistry.untrack(self);
        agentRegistry.untrack(alpha);
        agentRegistry.untrack(beta);
      }
    }, 300_000);
  }
});
