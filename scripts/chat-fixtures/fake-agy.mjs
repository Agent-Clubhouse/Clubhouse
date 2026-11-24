#!/usr/bin/env node
// Fake Antigravity CLI (`agy`) for tests: no binary, no account, no network,
// no model. Every shape below is hand-built from Google's public docs or the
// ACP v1 schema (src/main/chat/acp/schema). None of it was recorded from a
// real `agy`, and passing against it proves nothing about the real CLI.
// Shapes the docs don't give are listed in SYNTHESIZED and in every report.
//
//   node scripts/chat-fixtures/fake-agy.mjs [--fake-agy-config <json>] [--fake-agy-report <json>] [agy args…]
//
// Personalities, chosen by the agy arguments as the real CLI would:
//   --version             prints `config.versionOutput` (default: the version)
//   models / agents       the documented `agy models` table; agents one per line
//   acp [--help]          an ACP v1 agent on stdio (newline-delimited JSON-RPC 2.0)
//   -p/--print/--prompt   headless, `--output-format text|json|stream-json`,
//                         `--input-format stream-json`
//   (anything else)       a TUI stub for PTY tests: runs `.agents/hooks.json`
//                         from the working directory, echoes input, exits on
//                         `/exit` or `/quit`
//
// Options (flag or environment variable):
//   --fake-agy-config <path>  CLUBHOUSE_FAKE_AGY_CONFIG  JSON config (see DEFAULTS); missing means defaults
//   --fake-agy-report <path>  CLUBHOUSE_FAKE_AGY_REPORT  JSON report, rewritten after every step
//
// The report holds what a test needs to check a launch: argv, cwd, a short
// allowlist of Clubhouse variables, and only the *names* of credential
// variables that are set. It never holds a nonce, a key or an environment dump.
// MCP server entries sent over ACP are reduced to their names and the names of
// their env/header keys.
//
// The fake never reads HOME or ~/.gemini, never writes outside the report, and
// only runs hook commands from the working directory's `.agents/hooks.json`.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FAKE_AGY_SOURCE = 'document-derived';

/**
 * What the docs don't say, and the fake makes up. Kept in every report so a
 * test or reader can't mistake one of these for a documented fact.
 */
export const SYNTHESIZED = [
  '`agy --version` output format',
  '`agy agents` output format',
  'ACP initialize agentCapabilities, agentInfo.version and authMethods descriptions',
  'ACP config option ids and thinking-level value ids (labels Low..Max are documented)',
  'ACP model option value ids and the default model',
  'ACP session mode ids (taken from the --mode values and the changelog)',
  'ACP permission option ids and kinds (labels Allow and Deny are documented)',
  'ACP session ids, list timestamps, and the session/close then session/prompt error',
  'ACP steer wire semantics (all three acp.steer variants are assumptions)',
  'ACP cancel: open tool calls end as tool_call_update status failed',
  'ACP mcpCapabilities.http tied to --process-per-session',
  'headless conversation ids, durations, token counts and the soft-deny stderr notice',
  'headless authentication-required exit code and message text',
  'hook handler exit-code and non-JSON stdout handling (hooks.onFailure)',
  'hook transcriptPath/artifactDirectoryPath values (never read or written)',
  'TUI screen output',
];

/** Defaults. A config file is merged over these, one level deep per section. */
export const DEFAULTS = {
  version: '1.5.12',
  versionOutput: null,
  /** `[slug, display name]`, from the docs' `agy models` example (first rows). */
  models: [
    ['gemini-4-neon-high', 'Gemini 4 Neon (High)'],
    ['gemini-4-neon-medium', 'Gemini 4 Neon (Medium)'],
    ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'],
  ],
  agents: ['default'],
  acp: {
    supported: true,
    protocolVersion: 1,
    /** `ok`, or `required`: session requests fail with -32000 `Authentication required`. */
    auth: 'ok',
    /** `refuse` (JSON-RPC error, and recorded) or `succeed` (flips auth to ok). Clubhouse should never call it. */
    authenticate: 'refuse',
    /** Ids for the two documented session options. Consumers should select by `category`. */
    configOptionIds: { model: 'model', thoughtLevel: 'thinking_level' },
    currentModel: null,
    currentThoughtLevel: 'medium',
    /** `auto` mode is offered (1.5.4+, not business accounts). */
    autoMode: true,
    /** Sent as available_commands_update after session/new. Names aren't documented, so none by default. */
    availableCommands: [],
    /** `join-first-ends`, `both-end` or `second-rejected`. See steer() below. */
    steer: 'both-end',
    /** Conversations the agent already has, for load/resume/list. */
    sessions: [
      {
        sessionId: 'agy-session-stored',
        cwd: null,
        title: 'Stored fake conversation',
        updatedAt: '2026-11-23T00:00:00.000Z',
        history: [
          { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier prompt' } },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } },
        ],
      },
    ],
    /** Extra prompt scripts, run by a prompt whose text is `agy:<name>`. */
    scripts: {},
  },
  headless: {
    /** `success`, `tool`, `soft-deny`, `error` or `auth-required`. */
    scenario: 'success',
    response: 'ok',
    authRequiredExitCode: 1,
  },
  tui: {
    /** Where the argv banner goes: `stderr`, `stdout` or `none`. */
    banner: 'stderr',
    /** Tool call simulated for each input line, so PreToolUse/PostToolUse hooks run. null for none. */
    tool: { name: 'run_command', args: { CommandLine: 'echo fake', Cwd: '.' } },
    /** How many times a Stop hook's `continue` may re-enter the loop per input. */
    stopContinueLimit: 1,
  },
  hooks: {
    /** Treatment of a handler that exits non-zero, times out or prints non-JSON. Undocumented: `allow` (ignored) or `deny`. */
    onFailure: 'allow',
    /** `inherit` the fake's environment (an assumption) or `minimal` (PATH only). */
    env: 'inherit',
    /** Upper bound on any handler timeout, so a test never waits the documented 30s default. */
    maxTimeoutMs: 10_000,
  },
};

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const ACP_THOUGHT_LEVELS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['extra', 'Extra'], ['max', 'Max']];
const ACP_MODES = [['default', 'Default'], ['accept-edits', 'Accept edits'], ['plan', 'Plan'], ['auto', 'Auto']];
const ERR = { methodNotFound: -32601, invalidParams: -32602, internal: -32603, authRequired: -32000, notFound: -32002 };
const CREDENTIAL_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'AGY_ADC_AUTH', 'CLUBHOUSE_CREDENTIAL_SENTINEL'];
const REPORTED_ENV = ['CLUBHOUSE_AGENT_ID', 'CLUBHOUSE_MCP_PORT', 'AGY_CLI_DISABLE_AUTO_UPDATE'];
const CONVERSATION_ID = '00000000-0000-4000-8000-00000000a6e1';

// ── Options, config and report ─────────────────────────────────────────────

function parseOptions(argv) {
  const opts = { config: process.env.CLUBHOUSE_FAKE_AGY_CONFIG, report: process.env.CLUBHOUSE_FAKE_AGY_REPORT, args: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fake-agy-config') opts.config = argv[++i];
    else if (argv[i] === '--fake-agy-report') opts.report = argv[++i];
    else opts.args.push(argv[i]);
  }
  return opts;
}

export function loadConfig(file) {
  const raw = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const out = { ...DEFAULTS, ...raw };
  for (const section of ['acp', 'headless', 'tui', 'hooks']) out[section] = { ...DEFAULTS[section], ...(raw[section] ?? {}) };
  out.acp.configOptionIds = { ...DEFAULTS.acp.configOptionIds, ...(raw.acp?.configOptionIds ?? {}) };
  return out;
}

/** Which personality an agy command line selects. */
export function personalityOf(args) {
  if (args.includes('--version')) return 'version';
  if (args[0] === 'models') return 'models';
  if (args[0] === 'agents') return 'agents';
  if (args[0] === 'acp') return 'acp';
  if (args.some((a) => a === '-p' || a === '--print' || a === '--prompt') || flagValue(args, '--input-format') === 'stream-json') return 'headless';
  return 'tui';
}

function flagValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) return args[i + 1];
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return undefined;
}

// Set by main() when run as a program. Tests import the pure helpers only.
let opts;
let config;
let args;
let personality;
let report;

function setup() {
  opts = parseOptions(process.argv.slice(2));
  try {
    config = loadConfig(opts.config);
  } catch (err) {
    process.stderr.write(`fake-agy: cannot read config ${opts.config}: ${err.message}\n`);
    process.exit(2);
  }
  args = opts.args;
  personality = personalityOf(args);
  report = {
    fake: 'fake-agy',
    source: FAKE_AGY_SOURCE,
    synthesized: SYNTHESIZED,
    pid: process.pid,
    personality,
    argv: args,
    cwd: process.cwd(),
    env: Object.fromEntries(REPORTED_ENV.map((name) => [name, process.env[name] ?? null])),
    hookNoncePresent: 'CLUBHOUSE_HOOK_NONCE' in process.env,
    credentialKeysPresent: CREDENTIAL_KEYS.filter((key) => key in process.env),
    acp: null,
    headless: null,
    tui: null,
    hooks: [],
    exitCode: null,
  };
}

/** Report files: the given path, one per personality, and one per agent when CLUBHOUSE_AGENT_ID is set. */
function reportFiles() {
  if (!opts.report) return [];
  const files = [opts.report, `${opts.report}.${personality}.json`];
  if (process.env.CLUBHOUSE_AGENT_ID) {
    files.push(`${opts.report}.agent-${createHash('sha256').update(process.env.CLUBHOUSE_AGENT_ID).digest('hex')}.json`);
  }
  return files;
}

function writeReport() {
  for (const file of reportFiles()) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(report, null, 2));
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(tmp, file);
          break;
        } catch (err) {
          // Windows refuses the rename while a reader has the file open.
          if (attempt >= 20) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    } catch {
      // Best effort; never let reporting break the fake.
    }
  }
}

function finish(code) {
  report.exitCode = code;
  writeReport();
  process.stdout.write('', () => process.exit(code));
}

/** Exit when the launcher dies (a killed Windows cmd.exe shim leaves us behind otherwise). */
function watchParent() {
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      finish(0);
    }
  }, 250).unref();
}

/** Newline-delimited stdin; CR alone also ends a line, as a PTY sends Enter. */
function readLines(onLine, onEnd) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r\n|\n|\r/);
    buffer = parts.pop() ?? '';
    for (const line of parts) onLine(line);
  });
  process.stdin.on('end', () => {
    if (buffer) onLine(buffer);
    onEnd();
  });
}

// ── Short commands ────────────────────────────────────────────────────────

function runVersion() {
  // A probe, not a session: like fake-cli, it leaves the report alone.
  opts.report = undefined;
  process.stdout.write(`${config.versionOutput ?? config.version}\n`);
  finish(0);
}

function runModels() {
  opts.report = undefined;
  const width = Math.max(...config.models.map(([slug]) => slug.length)) + 3;
  process.stdout.write(config.models.map(([slug, name]) => `${slug.padEnd(width)}${name}`).join('\n') + '\n');
  finish(0);
}

function runAgents() {
  opts.report = undefined;
  process.stdout.write(config.agents.join('\n') + '\n');
  finish(0);
}

// ── Hooks ─────────────────────────────────────────────────────────────────

/** `.agents/hooks.json` in the working directory only. A missing file is no hooks; a broken one is reported. */
function loadWorkspaceHooks() {
  const file = join(process.cwd(), '.agents', 'hooks.json');
  if (!existsSync(file)) return { file: null, hooks: {} };
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { file, hooks: JSON.parse(text) ?? {} };
  } catch (err) {
    report.hooks.push({ event: null, name: null, error: `unreadable hooks file: ${err.message}` });
    return { file, hooks: {} };
  }
}

/** Handlers for one event, in file order: `[{ name, handler }]`. Tool events filter by `matcher`. */
export function handlersFor(hooksFile, event, toolName) {
  const out = [];
  for (const [name, def] of Object.entries(hooksFile ?? {})) {
    if (!def || typeof def !== 'object' || def.enabled === false) continue;
    const groups = Array.isArray(def[event]) ? def[event] : [];
    for (const group of groups) {
      if (TOOL_EVENTS.has(event)) {
        const matcher = group?.matcher ?? '';
        if (matcher !== '' && matcher !== '*' && !matches(matcher, toolName ?? '')) continue;
        for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) out.push({ name, handler });
      } else {
        out.push({ name, handler: group });
      }
    }
  }
  return out.filter(({ handler }) => handler && typeof handler.command === 'string' && (handler.type ?? 'command') === 'command');
}

function matches(matcher, name) {
  try {
    return new RegExp(`^(?:${matcher})$`).test(name);
  } catch {
    return false;
  }
}

function hookPayload(event, extra) {
  return {
    ...extra,
    conversationId: CONVERSATION_ID,
    workspacePaths: [process.cwd()],
    // Doc-shaped strings only; the fake never creates, reads or writes these.
    transcriptPath: `~/.gemini/antigravity-cli/brain/${CONVERSATION_ID}/.system_generated/logs/transcript.jsonl`,
    artifactDirectoryPath: `~/.gemini/antigravity-cli/brain/${CONVERSATION_ID}`,
    modelName: flagValue(args, '--model') ?? config.models[0]?.[0] ?? '',
  };
}

function runHandler(handler, payload) {
  const timeoutMs = Math.min((Number(handler.timeout) || 30) * 1000, config.hooks.maxTimeoutMs);
  // `minimal` keeps only what a shell needs to start (cmd.exe needs SystemRoot).
  const env = config.hooks.env === 'minimal'
    ? Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec'].filter((k) => k in process.env).map((k) => [k, process.env[k]]))
    : process.env;
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(handler.command, { shell: true, cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    // A shell's grandchild can outlive the kill and hold stdout open, so a timeout settles at once.
    const timer = setTimeout(() => {
      child.kill();
      settle({ code: null, timedOut: true, stdout });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.on('error', () => settle({ code: null, timedOut: false, stdout }));
    child.on('close', (code) => settle({ code, timedOut: false, stdout }));
  });
}

/**
 * Run every handler for `event`. Returns the combined decision: for
 * PreToolUse the first non-`allow` decision wins (`deny` blocks); for Stop,
 * `continue` if any handler asked to keep going.
 */
async function runHooks(hooksFile, event, extra = {}) {
  const toolName = extra.toolCall?.name;
  let decision = event === 'PreToolUse' ? 'allow' : undefined;
  for (const { name, handler } of handlersFor(hooksFile, event, toolName)) {
    const result = await runHandler(handler, hookPayload(event, extra));
    let output = null;
    try {
      output = result.stdout.trim() ? JSON.parse(result.stdout) : {};
    } catch {
      output = null;
    }
    const failed = result.timedOut || result.code !== 0 || output === null;
    let handlerDecision = output?.decision;
    if (failed) handlerDecision = config.hooks.onFailure === 'deny' && event === 'PreToolUse' ? 'deny' : undefined;
    report.hooks.push({ event, name, exitCode: result.code, timedOut: result.timedOut, jsonOutput: output !== null, decision: handlerDecision ?? null, failed });
    writeReport();
    if (event === 'PreToolUse' && handlerDecision && handlerDecision !== 'allow' && decision === 'allow') decision = handlerDecision;
    if (event === 'Stop' && handlerDecision === 'continue') decision = 'continue';
  }
  return decision;
}

// ── TUI stub ──────────────────────────────────────────────────────────────

async function runTui() {
  report.tui = { inputs: [], toolDecisions: [] };
  watchParent();
  const banner = `fake-agy tui argv=${JSON.stringify(args)}\n`;
  if (config.tui.banner === 'stderr') process.stderr.write(banner);
  else if (config.tui.banner === 'stdout') process.stdout.write(banner);
  const { hooks } = loadWorkspaceHooks();
  writeReport();
  await runHooks(hooks, 'SessionStart');
  process.stdout.write('> ');

  const queue = [];
  let wake = null;
  let ended = false;
  readLines((line) => { queue.push(line); wake?.(); }, () => { ended = true; wake?.(); });
  let invocation = 0;
  let step = 0;
  for (;;) {
    while (queue.length === 0 && !ended) await new Promise((resolve) => { wake = resolve; });
    if (queue.length === 0) return finish(0);
    const line = queue.shift().trim();
    if (!line) continue;
    report.tui.inputs.push(line);
    writeReport();
    if (line === '/exit' || line === '/quit') return finish(0);
    for (let execution = 1, continues = 0; ; execution++) {
      const invocationExtra = { invocationNum: invocation++, initialNumSteps: step, lastUserInput: line };
      await runHooks(hooks, 'PreInvocation', invocationExtra);
      if (config.tui.tool) {
        const toolCall = { name: config.tui.tool.name, args: config.tui.tool.args };
        const decision = await runHooks(hooks, 'PreToolUse', { toolCall, stepIdx: step, lastUserInput: line });
        report.tui.toolDecisions.push({ tool: toolCall.name, decision });
        const ran = decision !== 'deny' && decision !== 'deny_unless_prior_grant';
        process.stdout.write(ran ? `tool ${toolCall.name} ran\n` : `tool ${toolCall.name} denied by hook\n`);
        if (ran) await runHooks(hooks, 'PostToolUse', { toolCall, stepIdx: step, lastUserInput: line });
        step++;
      }
      process.stdout.write(`fake-agy: ${line}\n`);
      step++;
      await runHooks(hooks, 'PostInvocation', invocationExtra);
      const stop = await runHooks(hooks, 'Stop', { executionNum: execution, terminationReason: 'model_stop', error: '', fullyIdle: true, lastUserInput: line });
      if (stop !== 'continue' || continues++ >= config.tui.stopContinueLimit) break;
    }
    process.stdout.write('> ');
  }
}

// ── Headless ──────────────────────────────────────────────────────────────

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
const TURN_USAGE = { input_tokens: 100, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 102 };

function addUsage(a, b) {
  return Object.fromEntries(Object.keys(ZERO_USAGE).map((k) => [k, a[k] + b[k]]));
}

async function runHeadless() {
  const format = flagValue(args, '--output-format') ?? 'text';
  const inputFormat = flagValue(args, '--input-format') ?? 'text';
  const model = flagValue(args, '--model');
  const conversationId = flagValue(args, '--conversation') ?? CONVERSATION_ID;
  const skip = args.includes('--dangerously-skip-permissions');
  const scenario = config.headless.scenario;
  report.headless = { format, inputFormat, scenario, model: model ?? null, prompts: [], softDenied: [] };
  watchParent();
  writeReport();

  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
  let usage = { ...ZERO_USAGE };
  let turns = 0;
  let step = 0;
  const result = (status, response, error) => ({
    conversation_id: conversationId,
    status,
    response,
    ...(error !== undefined && { error }),
    duration_seconds: 0.01 * turns,
    num_turns: turns,
    usage,
  });
  /** A run that failed before any turn: an ERROR envelope in json modes, the reason on stderr. */
  const failEarly = (error, code, conversation_id) => {
    const env = { ...result('ERROR', '', error), conversation_id };
    if (format === 'json') process.stdout.write(JSON.stringify(env) + '\n');
    else if (format === 'stream-json') emit({ event: 'result', result: env });
    process.stderr.write(`${error}\n`);
    return finish(code);
  };

  if (scenario === 'auth-required') return failEarly('authentication required', config.headless.authRequiredExitCode, conversationId);
  if (model && !config.models.some(([slug]) => slug === model)) {
    const list = config.models.map(([, name]) => `  ${name}`).join('\n');
    return failEarly(`invalid model selection (--model "${model}" --effort "${flagValue(args, '--effort') ?? ''}"): model ${model} is not recognized as a known model or custom model in settings\nAvailable models:\n${list}`, 1, '');
  }

  if (format === 'stream-json') {
    const init = { cwd: process.cwd(), tools: ['ask_permission', 'run_command', 'write_to_file'], permission_mode: skip ? 'always-proceed' : 'request-review' };
    if (model) init.model = model;
    const agent = flagValue(args, '--agent');
    if (agent) init.agent = agent;
    emit({ event: 'init', conversation_id: conversationId, init });
  }

  /** One turn. Returns the exit code it ends the run with, or null to keep going. */
  const turn = (prompt) => {
    report.headless.prompts.push(prompt);
    turns++;
    const step_update = (fields) => emit({ event: 'step_update', step_update: { conversation_id: conversationId, step_index: step++, ...fields } });
    if (format === 'stream-json') step_update({ state: 'DONE', step_type: 'user_input' });
    if (scenario === 'error') {
      usage = addUsage(usage, TURN_USAGE);
      const env = result('ERROR', '', 'fake-agy: scripted turn error');
      if (format === 'json') process.stdout.write(JSON.stringify(env) + '\n');
      else if (format === 'stream-json') emit({ event: 'result', result: env });
      process.stderr.write('fake-agy: scripted turn error\n');
      return 1;
    }
    if (scenario === 'tool' || scenario === 'soft-deny') {
      const denied = scenario === 'soft-deny' && !skip;
      const tool_info = { name: 'run_command', parameters: { CommandLine: 'echo fake' }, ...(denied ? { error: { type: 'permission_denied', message: 'fake-agy: soft-denied' } } : { output: 'fake\n' }) };
      if (format === 'stream-json') step_update({ state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.01, tool_info });
      if (denied) {
        report.headless.softDenied.push('run_command');
        process.stderr.write('fake-agy: run_command was soft-denied; allow it with a command(...) rule under permissions.allow\n');
      }
    }
    const response = `${config.headless.response}\n`;
    usage = addUsage(usage, TURN_USAGE);
    if (format === 'stream-json') {
      step_update({ state: 'ACTIVE', step_type: 'agent_response', text_delta: config.headless.response });
      step_update({ state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 0.01, usage: TURN_USAGE });
      emit({ event: 'result', result: result('SUCCESS', response) });
    } else if (format === 'json') {
      process.stdout.write(JSON.stringify(result('SUCCESS', response)) + '\n');
    } else {
      process.stdout.write(response);
    }
    writeReport();
    return null;
  };

  if (inputFormat !== 'stream-json') {
    const prompt = flagValue(args, '-p', '--print', '--prompt') ?? '';
    return finish(turn(prompt) ?? 0);
  }

  // `--input-format stream-json`: user events on stdin until it closes.
  const lines = [];
  let wake = null;
  let ended = false;
  readLines((line) => { lines.push(line); wake?.(); }, () => { ended = true; wake?.(); });
  const endWith = (error, code) => {
    const env = result('ERROR', '', error);
    if (format === 'stream-json') emit({ event: 'result', result: env });
    else if (format === 'json') process.stdout.write(JSON.stringify(env) + '\n');
    process.stderr.write(`${error}\n`);
    return finish(code);
  };
  for (;;) {
    while (lines.length === 0 && !ended) await new Promise((resolve) => { wake = resolve; });
    if (lines.length === 0) return finish(0);
    const line = lines.shift();
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return endWith('invalid JSON on stdin', 1);
    }
    if (!msg || typeof msg !== 'object' || !('event' in msg)) return endWith('stream input message has no "event" field', 1);
    if (msg.event === 'control_request' || msg.event === 'control_response') return endWith(`${msg.event} events are not supported with --input-format stream-json`, 2);
    if (msg.event !== 'user') {
      process.stderr.write(`warning: ignoring unsupported stream input message event "${msg.event}"\n`);
      continue;
    }
    const content = msg.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const other = blocks.find((b) => b?.type !== 'text');
    if (other) return endWith(`unsupported content block type "${other?.type}"; text is the only supported block type`, 1);
    const text = blocks.map((b) => b.text).join('');
    const slash = /^\/(\S+)/.exec(text.trim());
    if (slash) return endWith(`/${slash[1]} is answered by the CLI itself and is unavailable with --input-format stream-json; run it as its own --print /${slash[1]} invocation`, 2);
    const code = turn(text);
    if (code !== null) return finish(code);
  }
}

// ── ACP ───────────────────────────────────────────────────────────────────

/** Built-in prompt scripts, run by a prompt whose text is `agy:<name>`. Anything else echoes. */
const BUILTIN_SCRIPTS = {
  text: [{ chunk: 'fake answer' }, { end: 'end_turn' }],
  tool: [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'call-edit', title: 'Edit notes.txt', kind: 'edit', status: 'pending', locations: [{ path: 'notes.txt' }] } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-edit', status: 'completed', content: [{ type: 'diff', path: 'notes.txt', oldText: 'old', newText: 'new' }] } },
    { chunk: 'edited' },
    { end: 'end_turn' },
  ],
  permission: [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'call-run', title: 'Run echo fake', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'echo fake' } } },
    {
      permission: { toolCallId: 'call-run', title: 'Run echo fake', kind: 'execute' },
      outcomes: {
        allow: [
          { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-run', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'fake' } }] } },
          { chunk: 'ran it' },
          { end: 'end_turn' },
        ],
        deny: [
          { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-run', status: 'failed' } },
          { chunk: 'skipped it' },
          { end: 'end_turn' },
        ],
      },
    },
  ],
  question: [
    {
      question: {
        message: 'Which file?',
        requestedSchema: { type: 'object', properties: { file: { type: 'string', title: 'File' } }, required: ['file'] },
      },
    },
    { end: 'end_turn' },
  ],
  hold: [{ chunk: 'working' }, { hold: true }, { chunk: 'done' }, { end: 'end_turn' }],
  refusal: [{ end: 'refusal' }],
  error: [{ chunk: 'partial' }, { error: { code: ERR.internal, message: 'Internal error' } }],
  auth: [{ error: { code: ERR.authRequired, message: 'Authentication required' } }],
  usage: [{ update: { sessionUpdate: 'usage_update', used: 1200, size: 1_000_000 } }, { chunk: 'counted' }, { end: 'end_turn' }],
  title: [{ update: { sessionUpdate: 'session_info_update', title: 'Fake title' } }, { chunk: 'titled' }, { end: 'end_turn' }],
  'max-tokens': [{ chunk: 'trunc' }, { end: 'max_tokens' }],
};

function runAcp() {
  if (!config.acp.supported) {
    opts.report = undefined;
    process.stderr.write('Error: unknown command "acp" for "agy"\n');
    return finish(1);
  }
  if (args.includes('--help') || args.includes('-h')) {
    opts.report = undefined;
    process.stdout.write('Usage:\n  agy acp [flags]\n\nStarts an Agent Client Protocol (ACP) server on stdin/stdout. (fake-agy)\n');
    return finish(0);
  }
  if (args.includes('--login')) {
    opts.report = undefined;
    process.stderr.write('fake-agy: --login is interactive and is not simulated\n');
    return finish(2);
  }
  watchParent();
  const state = {
    initialized: null,
    received: [],
    clientResponses: [],
    late: [],
    authenticateCalls: 0,
    autoApproved: [],
    steers: [],
    cancels: 0,
  };
  report.acp = state;
  let auth = config.acp.auth;
  const skipPermissions = args.includes('--dangerously-skip-permissions');
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  const notify = (sessionId, update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });

  const ids = config.acp.configOptionIds;
  const sessions = new Map();
  for (const s of config.acp.sessions) sessions.set(s.sessionId, newSessionState(s.sessionId, s.cwd ?? process.cwd(), s));
  let nextSession = 1;
  let nextRequest = 1;
  const outgoing = new Map();

  function newSessionState(sessionId, cwd, seed = {}) {
    return {
      sessionId,
      cwd,
      title: seed.title ?? null,
      updatedAt: seed.updatedAt ?? '2026-11-23T00:00:00.000Z',
      history: [...(seed.history ?? [])],
      model: config.acp.currentModel ?? config.models[0]?.[0] ?? 'default',
      thought: config.acp.currentThoughtLevel,
      mode: 'default',
      closed: false,
      turn: null,
    };
  }

  function configOptions(s) {
    return [
      { id: ids.model, name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: config.models.map(([value, name]) => ({ value, name })) },
      { id: ids.thoughtLevel, name: 'Thinking level', category: 'thought_level', type: 'select', currentValue: s.thought, options: ACP_THOUGHT_LEVELS.map(([value, name]) => ({ value, name })) },
    ];
  }
  function modes(s) {
    const available = ACP_MODES.filter(([id]) => id !== 'auto' || config.acp.autoMode).map(([id, name]) => ({ id, name }));
    return { currentModeId: s.mode, availableModes: available };
  }
  const setup = (s) => ({ modes: modes(s), configOptions: configOptions(s) });

  /** Reduce MCP servers to names, so the report never holds a nonce or header value. */
  const describeMcp = (servers) => (Array.isArray(servers) ? servers : []).map((m) => ({
    name: m?.name,
    type: m?.type ?? 'stdio',
    ...(m?.command !== undefined && { command: m.command }),
    envNames: Array.isArray(m?.env) ? m.env.map((e) => e?.name) : [],
    headerNames: Array.isArray(m?.headers) ? m.headers.map((h) => h?.name) : [],
  }));
  const sanitize = (params) => {
    if (!params || typeof params !== 'object') return params;
    if ('mcpServers' in params) return { ...params, mcpServers: describeMcp(params.mcpServers) };
    return params;
  };

  /** Ask the client; resolves with its answer, or with `{ abandoned: true }` if the turn is cancelled first. */
  function requestClient(method, params, turn) {
    const id = `agy-${nextRequest++}`;
    return new Promise((resolve) => {
      outgoing.set(id, { method, resolve });
      turn?.pending.add(id);
      write({ jsonrpc: '2.0', id, method, params });
    });
  }

  function record(sessionId, update) {
    const s = sessions.get(sessionId);
    if (s && update.sessionUpdate !== 'usage_update') s.history.push(update);
    notify(sessionId, update);
  }

  /**
   * Run a prompt's steps. A turn owns the prompt request ids that joined it,
   * the open tool calls (ended on cancel) and its pending client requests.
   */
  async function runTurn(s, turn, steps) {
    for (const step of steps) {
      if (turn.cancelled) return endTurn(s, turn, 'cancelled');
      if ('chunk' in step) record(s.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.chunk } });
      else if ('update' in step) {
        const u = step.update;
        if (u.sessionUpdate === 'tool_call' && u.status !== 'completed' && u.status !== 'failed') turn.openTools.add(u.toolCallId);
        if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) turn.openTools.delete(u.toolCallId);
        if (u.sessionUpdate === 'session_info_update' && u.title) s.title = u.title;
        record(s.sessionId, u);
      } else if ('permission' in step) {
        const options = step.options ?? [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }];
        let chosen;
        if (skipPermissions) {
          chosen = options.find((o) => o.kind.startsWith('allow'))?.optionId;
          state.autoApproved.push(step.permission.toolCallId);
        } else {
          const answer = await requestClient('session/request_permission', { sessionId: s.sessionId, toolCall: step.permission, options }, turn);
          if (answer.abandoned || turn.cancelled) return endTurn(s, turn, 'cancelled');
          const outcome = answer.result?.outcome;
          chosen = outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled';
          if (chosen === 'cancelled') return endTurn(s, turn, 'cancelled');
        }
        const branch = step.outcomes?.[chosen];
        if (!branch) return failTurn(s, turn, ERR.invalidParams, `fake-agy: unknown permission option ${chosen}`);
        return runTurn(s, turn, branch);
      } else if ('question' in step) {
        const form = state.initialized?.clientCapabilities?.elicitation?.form;
        if (form) {
          const answer = await requestClient('elicitation/create', { sessionId: s.sessionId, mode: 'form', ...step.question }, turn);
          if (answer.abandoned || turn.cancelled) return endTurn(s, turn, 'cancelled');
          const action = answer.result?.action ?? 'error';
          record(s.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer: ${action} ${JSON.stringify(answer.result?.content ?? null)}` } });
        } else {
          // Documented fallback: clients without form elicitation see the question in chat.
          record(s.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.question.message } });
        }
      } else if ('hold' in step) {
        await new Promise((resolve) => { turn.release = resolve; });
        turn.release = null;
        if (turn.cancelled) return endTurn(s, turn, 'cancelled');
      } else if ('end' in step) {
        return endTurn(s, turn, step.end);
      } else if ('error' in step) {
        return failTurn(s, turn, step.error.code, step.error.message);
      } else if ('exit' in step) {
        return finish(step.exit);
      }
      writeReport();
    }
    return endTurn(s, turn, 'end_turn');
  }

  function closeTurn(s, turn) {
    if (s.turn !== turn) return false;
    s.turn = null;
    // Pending client requests are abandoned; a later answer lands in `late`.
    for (const id of turn.pending) {
      const waiter = outgoing.get(id);
      outgoing.delete(id);
      waiter?.resolve({ abandoned: true });
    }
    return true;
  }

  function endTurn(s, turn, stopReason) {
    if (!closeTurn(s, turn)) return;
    if (stopReason === 'cancelled') {
      for (const toolCallId of turn.openTools) notify(s.sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    }
    for (const id of turn.promptIds) reply(id, { stopReason });
    writeReport();
  }

  function failTurn(s, turn, code, message) {
    if (!closeTurn(s, turn)) return;
    for (const id of turn.promptIds) fail(id, code, message);
    writeReport();
  }

  /**
   * A prompt while a turn runs. The docs say it "steers that turn instead of
   * starting a new one", but not what the steering request is answered with.
   * Each variant is an assumption:
   *   both-end         held, then answered with the turn's stop reason, after the first
   *   join-first-ends  answered at once with end_turn; only the first carries the turn's end
   *   second-rejected  a JSON-RPC error; the turn is unaffected
   */
  function steer(s, id, text) {
    const variant = config.acp.steer;
    state.steers.push({ sessionId: s.sessionId, text, variant });
    if (variant === 'second-rejected') return fail(id, ERR.invalidParams, 'fake-agy: a turn is already running');
    record(s.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `steered: ${text}` } });
    if (variant === 'join-first-ends') reply(id, { stopReason: 'end_turn' });
    else s.turn.promptIds.push(id);
    s.turn.release?.();
  }

  function prompt(id, params) {
    const s = sessions.get(params?.sessionId);
    if (auth !== 'ok') return fail(id, ERR.authRequired, 'Authentication required');
    if (!s || s.closed) return fail(id, ERR.notFound, `Session not found: ${params?.sessionId}`);
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    if (blocks.some((b) => b?.type === 'audio')) return fail(id, ERR.invalidParams, 'fake-agy: audio prompts are not supported');
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
    if (s.turn) return steer(s, id, text);
    for (const b of blocks) s.history.push({ sessionUpdate: 'user_message_chunk', content: b });
    const turn = { promptIds: [id], openTools: new Set(), pending: new Set(), cancelled: false, release: null };
    s.turn = turn;
    const name = /^agy:(.+)$/.exec(text.trim())?.[1];
    let steps;
    const exit = name && /^exit:(\d+)$/.exec(name);
    if (exit) steps = [{ chunk: 'exiting' }, { exit: Number(exit[1]) }];
    else if (name) steps = config.acp.scripts[name] ?? BUILTIN_SCRIPTS[name];
    if (name && !steps) steps = [{ error: { code: ERR.invalidParams, message: `fake-agy: no script ${name}` } }];
    steps ??= [{ chunk: text.slice(0, 2) }, { chunk: text.slice(2) }, { end: 'end_turn' }];
    void runTurn(s, turn, steps);
  }

  const handlers = {
    initialize(params) {
      state.initialized = { protocolVersion: params?.protocolVersion, clientInfo: params?.clientInfo ?? null, clientCapabilities: params?.clientCapabilities ?? null };
      const terminalAuth = params?.clientCapabilities?.auth?.terminal === true;
      const authMethods = [
        { id: 'oauth-personal', name: 'Log in with Google' },
        { id: 'oauth-business', name: 'Log in with Gemini Enterprise' },
        { id: 'gemini-api-key', name: 'Gemini API key' },
        { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform' },
        // Documented as offered only to clients with ACP terminal authentication.
        ...(terminalAuth ? [{ type: 'terminal', id: 'terminal-login', name: 'Log in from the terminal', args: ['acp', '--login'] }] : []),
      ];
      return {
        protocolVersion: config.acp.protocolVersion,
        agentInfo: { name: 'Antigravity ACP Server', version: config.version },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: args.includes('--process-per-session'), sse: false },
          sessionCapabilities: { resume: {}, list: {}, close: {}, additionalDirectories: {} },
        },
        authMethods,
      };
    },
    authenticate() {
      state.authenticateCalls++;
      if (config.acp.authenticate !== 'succeed') throw { code: ERR.authRequired, message: 'fake-agy: authenticate is not simulated' };
      auth = 'ok';
      return {};
    },
    'session/new'(params) {
      if (auth !== 'ok') throw { code: ERR.authRequired, message: 'Authentication required' };
      const s = newSessionState(`agy-session-${nextSession++}`, params?.cwd ?? process.cwd());
      sessions.set(s.sessionId, s);
      return { sessionId: s.sessionId, ...setup(s), after: () => sendCommands(s) };
    },
    'session/load'(params) {
      if (auth !== 'ok') throw { code: ERR.authRequired, message: 'Authentication required' };
      const s = sessions.get(params?.sessionId);
      if (!s) throw { code: ERR.notFound, message: `Session not found: ${params?.sessionId}` };
      s.closed = false;
      for (const update of s.history) notify(s.sessionId, update);
      return { ...setup(s), after: () => sendCommands(s) };
    },
    'session/resume'(params) {
      if (auth !== 'ok') throw { code: ERR.authRequired, message: 'Authentication required' };
      const s = sessions.get(params?.sessionId);
      if (!s) throw { code: ERR.notFound, message: `Session not found: ${params?.sessionId}` };
      s.closed = false;
      return { ...setup(s), after: () => sendCommands(s) };
    },
    'session/list'(params) {
      if (auth !== 'ok') throw { code: ERR.authRequired, message: 'Authentication required' };
      const list = [...sessions.values()].filter((s) => !params?.cwd || s.cwd === params.cwd);
      return { sessions: list.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt })) };
    },
    'session/close'(params) {
      const s = sessions.get(params?.sessionId);
      if (!s) throw { code: ERR.notFound, message: `Session not found: ${params?.sessionId}` };
      if (s.turn) {
        s.turn.cancelled = true;
        endTurn(s, s.turn, 'cancelled');
      }
      s.closed = true;
      return {};
    },
    'session/set_config_option'(params) {
      const s = sessions.get(params?.sessionId);
      if (!s) throw { code: ERR.notFound, message: `Session not found: ${params?.sessionId}` };
      const option = configOptions(s).find((o) => o.id === params.configId);
      if (!option) throw { code: ERR.invalidParams, message: `Unknown config option ${params.configId}` };
      if (!option.options.some((o) => o.value === params.value)) throw { code: ERR.invalidParams, message: `Invalid value ${params.value} for ${params.configId}` };
      if (option.category === 'model') s.model = params.value;
      else s.thought = params.value;
      return { configOptions: configOptions(s) };
    },
    'session/set_mode'(params) {
      const s = sessions.get(params?.sessionId);
      if (!s) throw { code: ERR.notFound, message: `Session not found: ${params?.sessionId}` };
      if (!modes(s).availableModes.some((m) => m.id === params.modeId)) throw { code: ERR.invalidParams, message: `Unknown mode ${params.modeId}` };
      s.mode = params.modeId;
      return {};
    },
  };

  function sendCommands(s) {
    if (config.acp.availableCommands.length) notify(s.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: config.acp.availableCommands });
  }

  function onMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (typeof msg.method !== 'string') {
      // An answer to one of our requests.
      const waiter = outgoing.get(msg.id);
      const entry = { id: msg.id, method: waiter?.method ?? null, result: msg.result ?? null, error: msg.error ?? null };
      if (waiter) {
        outgoing.delete(msg.id);
        state.clientResponses.push(entry);
        waiter.resolve(msg);
      } else {
        state.late.push(entry);
      }
      return writeReport();
    }
    state.received.push({ method: msg.method, ...(msg.id !== undefined && { id: msg.id }), params: sanitize(msg.params) });
    writeReport();
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'session/cancel') {
        state.cancels++;
        const s = sessions.get(msg.params?.sessionId);
        if (s?.turn) {
          // "Cancelling a turn ends open tool calls and abandons pending permission requests."
          const turn = s.turn;
          turn.cancelled = true;
          endTurn(s, turn, 'cancelled');
          turn.release?.();
        }
      }
      return;
    }
    if (msg.method === 'session/prompt') return prompt(msg.id, msg.params);
    const handler = handlers[msg.method];
    if (!handler) return fail(msg.id, ERR.methodNotFound, `Method not found: ${msg.method}`);
    try {
      const { after, ...result } = handler(msg.params) ?? {};
      reply(msg.id, result);
      after?.();
    } catch (err) {
      fail(msg.id, err?.code ?? ERR.internal, err?.message ?? String(err));
    }
    writeReport();
  }

  writeReport();
  readLines((line) => { if (line.trim()) onMessage(line); }, () => finish(0));
}

// ── Main ──────────────────────────────────────────────────────────────────

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  setup();
  process.stdout.on('error', () => finish(0));
  if (personality === 'version') runVersion();
  else if (personality === 'models') runModels();
  else if (personality === 'agents') runAgents();
  else if (personality === 'acp') runAcp();
  else if (personality === 'headless') await runHeadless();
  else await runTui();
}
