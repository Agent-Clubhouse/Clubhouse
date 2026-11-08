/**
 * One fixed prompt through each chat driver against REAL CLIs, the REAL model
 * and the machine's own logins. This SPENDS MONEY, so it never runs by itself:
 * it is skipped unless CLUBHOUSE_LIVE_DRIVER_SMOKE=1, and always in CI.
 *
 * Without CLUBHOUSE_LIVE_DRIVER_MODELS no prompt is sent: each driver starts,
 * reports the models it lists and what it loaded, and closes.
 *
 *   CLUBHOUSE_LIVE_DRIVER_MODELS  JSON { "<driver id>": { "model": "...", "effort": "low" } }
 *   CLUBHOUSE_LIVE_DRIVER_ONLY    comma list of driver ids (default: all five)
 *   CLUBHOUSE_LIVE_DRIVER_REPORT  write a JSON report here. Keep it out of the repo:
 *                                 it names local paths and session ids.
 *
 * Each driver runs once, with no retry: a failure is recorded and never re-sent.
 * The user's MCP servers and tools are switched off for the session by flags
 * only; no CLI config is written. Any permission request is denied and fails
 * the driver. Not everything goes off: Codex keeps its built-in tools, Copilot
 * over the SDK still connects github-mcp-server (its tools are disabled).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatDriver, ChatDriverId, ChatDriverSession } from '../../shared/chat';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(os.tmpdir(), `clubhouse-live-driver-${name}`), getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { ClaudeChatDriver } from './claude';
import { CopilotSdkChatDriver } from './copilot/driver';
import { getProvider, registerBuiltinProviders, type OrchestratorId } from '../orchestrators';
import { CodexChatDriver } from '../orchestrators/adapters/codex-chat-driver';
import { evaluateCliVersion } from '../services/agent-runtime/chat-version-policy';
import { cleanInheritedEnv, getShellEnvironment } from '../util/shell';

const enabled = process.env.CLUBHOUSE_LIVE_DRIVER_SMOKE === '1' && !process.env.CI;
const PROMPT = 'Reply with the single word ok.';
const TURN_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 20_000;
/** How long a prompt-less start waits for its menus. */
const LIST_SETTLE_MS = 8_000;
const HOME = os.homedir();
const CLI_DIRS = ['.claude', '.codex', '.copilot'].map((d) => path.join(HOME, d));
/** What vitest sets for itself; a CLI should see the env the app gives it. */
const VITEST_ENV = /^(VITEST.*|NODE_ENV|TEST|DEV|PROD|SSR|MODE|BASE_URL)$/;

type Choice = { model: string; effort?: string };
const choices: Partial<Record<ChatDriverId, Choice>> | undefined = process.env.CLUBHOUSE_LIVE_DRIVER_MODELS
  ? JSON.parse(process.env.CLUBHOUSE_LIVE_DRIVER_MODELS)
  : undefined;
const only = process.env.CLUBHOUSE_LIVE_DRIVER_ONLY?.split(',').map((d) => d.trim());
const report: Record<string, unknown>[] = [];

function packageVersion(name: string): string {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8')).version;
}

/** Strips anything that came from the environment or home folder out of text bound for the report. */
function scrubber(env: Record<string, string>): (text: string) => string {
  const secrets = Object.values(env).filter((v) => v.length >= 12 && !v.startsWith('/') && !v.includes(':/'));
  return (text) => {
    let out = text.split(HOME).join('~');
    for (const s of secrets) out = out.split(s).join('[redacted]');
    return out.replace(/\b(sk-[\w-]{8,}|gh[opusr]_\w{8,}|github_pat_\w{8,}|eyJ[\w-]{16,}[\w.-]*)/g, '[redacted]').slice(0, 1_000);
  };
}

/** Path to size and mtime for every file below the CLI folders. Names only; contents aren't read. */
function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const st = fs.statSync(full, { throwIfNoEntry: false });
        if (st) files.set(full, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  for (const dir of CLI_DIRS) { try { walk(dir); } catch { /* absent, or changing under another agent */ } }
  return files;
}

/** Files that changed since `before`, split by whether their path names this session. */
function footprint(before: Map<string, string>, markers: string[]): { ours: string[]; others: string[] } {
  const changed = [...snapshot()].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file);
  const isOurs = (file: string) => markers.some((m) => file.includes(m));
  const short = (file: string) => file.replace(HOME, '~');
  return { ours: changed.filter(isOurs).map(short), others: changed.filter((f) => !isOurs(f)).map(short) };
}

function isReady(events: Array<{ type: string; data?: any }>): boolean {
  return events.some((e) => e.type === 'session_info' && e.data?.models?.length);
}

/** Permission, question and plan requests all get a no; the smoke approves nothing. */
function refuse(session: ChatDriverSession, data: any): Promise<void> {
  const options: Array<{ optionId?: string; id?: string; kind?: string }> = data.options ?? [];
  const reject = options.find((o) => /reject|deny/i.test(`${o.kind} ${o.optionId} ${o.id}`));
  return Promise.resolve(session.respondPermission(data.requestId, reject?.optionId ?? reject?.id ?? 'deny')).catch(() => undefined);
}

interface Spec {
  id: ChatDriverId;
  provider: OrchestratorId;
  sdk?: string;
  make(): ChatDriver;
  /** The chat runtime, not this driver, reports session_started and session_ended. */
  runtimeLifecycle?: boolean;
  /** The event carrying the reply, for a driver that only streams chunks. */
  messageEvent?: 'agent_message_chunk';
  /** Binary, flags and env that keep the user's MCP servers and tools out of this session. */
  isolate(binary: string, dir: string): { binary: string; extraArgs?: string[]; env?: Record<string, string>; isolation: string[] };
}

/**
 * Claude's drivers take no extra args, so a one-line wrapper adds the flags.
 * The driver still runs the user's own CLI, with the user's login.
 */
function claudeIsolation(binary: string, dir: string): ReturnType<Spec['isolate']> {
  const wrapper = path.join(dir, 'claude');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${binary.replace(/'/g, `'\\''`)}' --strict-mcp-config --tools "" "$@"\n`, { mode: 0o755 });
  return { binary: wrapper, env: { DISABLE_AUTOUPDATER: '1' }, isolation: ['--strict-mcp-config', '--tools ""', 'DISABLE_AUTOUPDATER=1'] };
}

/**
 * `-c` overrides merge into config.toml's tables, so each server goes off by
 * name (Codex misreads a quoted one). Plugins and apps bring their own servers.
 */
function codexIsolation(binary: string): ReturnType<Spec['isolate']> {
  const config = fs.readFileSync(path.join(process.env.CODEX_HOME ?? path.join(HOME, '.codex'), 'config.toml'), 'utf8');
  const servers = [...config.matchAll(/^\[mcp_servers\.([\w-]+)\]/gm)].map((m) => m[1]);
  const overrides = [...servers.map((s) => `mcp_servers.${s}.enabled=false`), 'notify=[]'];
  const features = ['apps', 'plugins', 'remote_plugin', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'skill_search'];
  return { binary, extraArgs: [...overrides.flatMap((o) => ['-c', o]), ...features.flatMap((f) => ['--disable', f])], isolation: [...overrides, ...features.map((f) => `--disable ${f}`)] };
}

function copilotIsolation(binary: string): ReturnType<Spec['isolate']> {
  const flags = ['--disable-builtin-mcps', '--available-tools='];
  return { binary, extraArgs: flags, isolation: flags };
}

const SPECS: Spec[] = [
  { id: 'claude_agent_sdk', provider: 'claude-code', sdk: '@anthropic-ai/claude-agent-sdk', make: () => new ClaudeChatDriver('claude_agent_sdk'), isolate: claudeIsolation },
  { id: 'claude_stream_json', provider: 'claude-code', make: () => new ClaudeChatDriver('claude_stream_json'), isolate: claudeIsolation },
  { id: 'codex_app_server', provider: 'codex-cli', make: () => new CodexChatDriver(), isolate: codexIsolation },
  {
    id: 'copilot_sdk',
    provider: 'copilot-cli',
    sdk: '@github/copilot-sdk',
    runtimeLifecycle: true,
    make: () => new CopilotSdkChatDriver({ sessionOverrides: { availableTools: [] } }),
    isolate: copilotIsolation,
  },
];

/** What a driver can say, without spending anything, about what the session loaded. */
async function inspect(id: ChatDriverId, session: ChatDriverSession): Promise<Record<string, unknown>> {
  const s = session as any;
  const out: Record<string, unknown> = {};
  try {
    if (id.startsWith('claude')) {
      const usage = await s.transport.contextUsage();
      out.toolTokens = (usage?.categories ?? []).filter((c: { name: string }) => /tool|mcp/i.test(c.name)).map((c: { name: string; tokens: number }) => ({ name: c.name, tokens: c.tokens }));
      out.mcpTools = (usage?.mcpTools ?? []).length;
      out.models = (s.modelRows ?? []).map((m: { value: string; efforts?: string[] }) => ({ id: m.value, efforts: m.efforts }));
    } else if (id === 'codex_app_server') {
      const status = await s.client.request('mcpServerStatus/list', {});
      out.mcpServers = (status?.data ?? []).map((m: { name: string; tools?: Record<string, unknown> }) => ({ name: m.name, tools: Object.keys(m.tools ?? {}).length }));
      out.models = (s.catalog ?? []).map((m: { model: string; isDefault?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort: string }> }) => ({ id: m.model, isDefault: m.isDefault, efforts: m.supportedReasoningEfforts?.map((e) => e.reasoningEffort) }));
    } else if (id === 'copilot_sdk') {
      out.models = (s.models ?? []).map((m: { id: string; billing?: { multiplier?: number }; supportedReasoningEfforts?: string[] }) => ({ id: m.id, multiplier: m.billing?.multiplier, efforts: m.supportedReasoningEfforts }));
    }
  } catch (err) {
    out.inspectError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

describe.skipIf(!enabled)('chat drivers (real CLI, real model, local logins)', () => {
  let root: string;
  let shellEnv: Record<string, string>;
  let scrub: (text: string) => string;
  let commit: string;

  beforeAll(() => {
    registerBuiltinProviders();
    // This runs under a Clubhouse agent: its identity and vitest's flags must not reach the CLIs.
    for (const key of Object.keys(process.env)) if (VITEST_ENV.test(key)) delete process.env[key];
    cleanInheritedEnv(process.env);
    shellEnv = cleanInheritedEnv({ ...getShellEnvironment() });
    scrub = scrubber(shellEnv);
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-driver-smoke-')));
  });

  afterAll(() => {
    const out = process.env.CLUBHOUSE_LIVE_DRIVER_REPORT;
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  for (const spec of SPECS.filter((s) => !only || only.includes(s.id))) {
    it(`${spec.id}: ${choices ? 'one prompt' : 'start and list, no prompt'}`, async () => {
      const dir = fs.mkdtempSync(path.join(root, `bin-${spec.id}-`));
      const cwd = fs.mkdtempSync(path.join(root, `cwd-${spec.id}-`));
      const provider = getProvider(spec.provider);
      if (!provider?.getBinaryPath) throw new Error(`provider ${spec.provider} has no binary lookup`);
      const choice = choices?.[spec.id];
      if (choices && !choice) throw new Error(`CLUBHOUSE_LIVE_DRIVER_MODELS has no entry for ${spec.id}`);
      const { binary, extraArgs, env, isolation } = spec.isolate(provider.getBinaryPath(), dir);

      const row: Record<string, unknown> = {
        driver: spec.id,
        commit,
        sdkVersion: spec.sdk ? packageVersion(spec.sdk) : undefined,
        model: choice?.model,
        effort: choice?.effort,
        isolation,
        promptSent: false,
      };
      report.push(row);
      const before = snapshot();
      const events: Array<{ type: string; data?: any }> = [];
      const t0 = Date.now();
      let session: ChatDriverSession | undefined;
      let drained: Promise<void> = Promise.resolve();
      let closedInTime = false;
      const failures: string[] = [];

      try {
        session = await spec.make().start({
          agentId: `live-${spec.id}`,
          provider: spec.provider,
          cwd,
          binaryPath: binary,
          level: 'ask',
          ...(choice?.model && { model: choice.model }),
          ...(choice?.effort && { effort: choice.effort }),
          ...(extraArgs && { extraArgs }),
          env: { ...shellEnv, ...env },
        });
        const started = session;
        drained = (async () => {
          for await (const ev of started.events) {
            const e = ev as { type: string; data?: any };
            events.push(e);
            if (e.type === 'permission_request') void refuse(started, e.data);
          }
        })();
        row.startMs = Date.now() - t0;

        if (choice) {
          row.promptSent = true;
          const sent = Date.now();
          await started.send([{ type: 'text', text: PROMPT }], 'prompt');
          // Waits for the one send above; nothing here sends again.
          await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_ended')).toBe(true), { timeout: TURN_TIMEOUT_MS, interval: 100 });
          row.turnMs = Date.now() - sent;
        } else {
          await vi.waitFor(() => expect(isReady(events)).toBe(true), { timeout: LIST_SETTLE_MS, interval: 100 }).catch(() => undefined);
          row.listedModels = events.filter((e) => e.type === 'session_info' && e.data?.models).at(-1)?.data.models;
          row.listedEfforts = events.filter((e) => e.type === 'session_info' && e.data?.efforts).at(-1)?.data.efforts;
        }
        row.inspected = await inspect(spec.id, started);
      } catch (err) {
        failures.push(scrub(err instanceof Error ? err.message : String(err)));
      } finally {
        const nativeId = session?.nativeSessionId;
        if (session) {
          await session.close().catch((err: Error) => failures.push(`close: ${scrub(err.message)}`));
          closedInTime = await Promise.race([
            drained.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), CLOSE_TIMEOUT_MS)),
          ]);
        }
        row.durationMs = Date.now() - t0;
        const ended = events.filter((e) => e.type === 'session_ended').at(-1)?.data;
        const started = events.find((e) => e.type === 'session_started')?.data;
        const cliVersion = started?.cliVersion ?? events.find((e) => e.type === 'session_info' && e.data?.cliVersion)?.data.cliVersion;
        row.cliVersion = cliVersion;
        row.versionStatus = evaluateCliVersion(spec.id, spec.provider, cliVersion).status;
        row.reportedModel = events.filter((e) => e.type === 'model_changed').at(-1)?.data.modelId ?? started?.model ?? events.filter((e) => e.type === 'session_info' && e.data?.model).at(-1)?.data.model;
        row.reportedEffort = events.filter((e) => e.type === 'model_changed').at(-1)?.data.effort;
        row.sequence = events.map((e) => e.type).filter((t, i, all) => t !== all[i - 1]);
        row.reply = events.filter((e) => e.type === 'agent_message').map((e) => scrub(String(e.data?.text ?? ''))).join('\n')
          || scrub(events.filter((e) => e.type === 'agent_message_chunk').map((e) => e.data?.text ?? '').join(''));
        row.usage = events.filter((e) => e.type === 'usage').map((e) => ({
          scope: e.data?.scope, tokens: e.data?.tokens, costUsd: e.data?.costUsd, costIsEstimate: e.data?.costIsEstimate, context: e.data?.context,
        })).filter((u) => u.tokens || u.costUsd !== undefined || u.context);
        const turnEnd = events.find((e) => e.type === 'turn_ended')?.data;
        row.turnEnded = turnEnd && { stopReason: turnEnd.stopReason, durationMs: turnEnd.durationMs, usage: turnEnd.usage, costUsd: turnEnd.costUsd };
        row.sessionEnded = ended && { reason: ended.reason, exitCode: ended.exitCode };
        row.closedInTime = closedInTime;
        row.mcpReported = events.filter((e) => e.type === 'session_info' && e.data?.mcpServers).at(-1)?.data.mcpServers;
        row.toolCalls = events.filter((e) => e.type === 'tool_call').length;
        row.permissionRequests = events.filter((e) => e.type === 'permission_request').length;
        row.protocolUnknown = events.filter((e) => e.type === 'protocol_unknown').map((e) => ({ kind: e.data?.kind, name: e.data?.name }));
        row.notices = events.filter((e) => e.type === 'notice').map((e) => ({ code: e.data?.code, message: scrub(String(e.data?.message ?? '')) }));
        row.errors = events.filter((e) => e.type === 'error').map((e) => ({ code: e.data?.code, fatal: e.data?.fatal, message: scrub(String(e.data?.message ?? '')) }));
        row.failures = failures;
        const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
        row.footprint = footprint(before, [slug, ...(nativeId ? [nativeId] : [])]);
        const claudeJson = path.join(HOME, '.claude.json');
        row.claudeJsonNamesCwd = fs.existsSync(claudeJson) && fs.readFileSync(claudeJson, 'utf8').includes(cwd);
      }

      expect(failures).toEqual([]);
      expect(row.errors).toEqual([]);
      expect(row.protocolUnknown).toEqual([]);
      expect(closedInTime).toBe(true);
      expect(row.toolCalls).toBe(0);
      expect(row.permissionRequests).toBe(0);
      if (!choice) return;
      const types = row.sequence as string[];
      const message = spec.messageEvent ?? 'agent_message';
      for (const type of ['turn_started', message, 'usage', 'turn_ended', ...(spec.runtimeLifecycle ? [] : ['session_started', 'session_ended'])]) {
        expect(types, `${type} missing`).toContain(type);
      }
      expect(types.indexOf('turn_started')).toBeLessThan(types.indexOf(message));
      if (!spec.runtimeLifecycle) expect(types.lastIndexOf('turn_ended')).toBeLessThan(types.lastIndexOf('session_ended'));
      expect(String(row.reply).trim()).toMatch(/^ok\.?$/i);
    }, TURN_TIMEOUT_MS + CLOSE_TIMEOUT_MS + 60_000);
  }
});
