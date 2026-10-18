#!/usr/bin/env node
// Fake `claude` for transport tests. Speaks `claude -p` stream-json plus the
// control protocol over stdio, with scripted turns keyed on the user's text.
// It never contacts a model. Shapes follow Claude Code 2.1.300 / Agent SDK
// 0.3.301 (captured from the SDK's types and a no-prompt initialize probe).
//
// Env:
//   FAKE_CLAUDE_ARGV_FILE  write process.argv.slice(2) as JSON here on start
//
// Scripted turns (user text):
//   hello  partial deltas, then the assistant text, then a success result
//   tool   Bash tool_use + can_use_tool; the result text reports the decision
//   ask    AskUserQuestion via can_use_tool; the result text reports the answers
//   sub    a Task subagent: task_started, its own text and tool call, then the report
//   limit  rate_limit_event before the result
//   novel  an unknown system subtype (drift) before the result
//   crash  exit 3 mid-turn
//   quit   a large final assistant message and result, then exit 0 at once
//   other  result.result = "echo:<text>|priority:<p>|shouldQuery:<b>"
//
// A `priority: "later"` message sent while a turn runs waits for that turn to
// end, as the CLI's queue does. Any other message sent mid-turn is a steer: it
// folds into the running turn, whose final text then ends with
// "|steered:<texts>".

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGV_FILE) writeFileSync(process.env.FAKE_CLAUDE_ARGV_FILE, JSON.stringify(argv));

function argValue(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

let permissionMode = argValue('--permission-mode') ?? 'default';
let model = argValue('--model') ?? 'claude-fake-1';
const sessionId = argValue('--resume') && !argv.includes('--fork-session') ? argValue('--resume') : 'fake-session-1';
let initSent = false;
let msgCounter = 0;
let ctlCounter = 0;
/** request_id → resolver for outstanding can_use_tool requests. */
const pendingPermissions = new Map();
/** The running turn, so `priority: "later"` messages can wait for it. */
let turnInFlight = null;
/** Steer texts folded into the running turn. */
let steered = [];

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const base = () => ({ session_id: sessionId, uuid: `uuid-${++msgCounter}` });

function result(text, extra = {}) {
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 12,
    duration_api_ms: 10,
    num_turns: 1,
    result: text,
    total_cost_usd: 0.0012,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens: 10, outputTokens: 5 } },
    queued_turn_count: 0,
    ...base(),
    ...extra,
  });
}

/** Report a decision as assistant text and as the result, so both raw and contract-level tests can see it. */
function say(text) {
  if (steered.length) {
    text += `|steered:${steered.join(',')}`;
    steered = [];
  }
  out({ type: 'assistant', message: { id: `msg_say_${msgCounter}`, role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, ...base() });
  result(text);
}

function ensureInit() {
  if (initSent) return;
  initSent = true;
  out({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '2.1.300-fake',
    cwd: process.cwd(),
    tools: ['Bash', 'Read', 'Edit'],
    mcp_servers: [{ name: 'clubhouse', status: 'connected' }, { name: 'github', status: 'needs-auth' }],
    model,
    permissionMode,
    slash_commands: ['compact', 'review'],
    output_style: 'default',
    skills: [],
    plugins: [],
    ...base(),
  });
}

function askPermission(request) {
  const requestId = `cli-${++ctlCounter}`;
  out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', ...request } });
  return new Promise((resolve) => pendingPermissions.set(requestId, resolve));
}

async function runTurn(msg) {
  const content = msg.message?.content;
  const text = typeof content === 'string'
    ? content
    : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  ensureInit();

  if (text === 'hello') {
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_hello' } }, parent_tool_use_id: null, ...base() });
    for (const t of ['Hel', 'lo']) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, parent_tool_use_id: null, ...base() });
    }
    out({ type: 'assistant', message: { id: 'msg_hello', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, parent_tool_use_id: null, ...base() });
    result('Hello');
    return;
  }

  if (text === 'tool') {
    const input = { command: 'ls' };
    out({ type: 'assistant', message: { id: 'msg_tool', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input }] }, parent_tool_use_id: null, ...base() });
    const decision = await askPermission({
      tool_name: 'Bash',
      input,
      tool_use_id: 'toolu_1',
      title: 'Claude wants to run ls',
      display_name: 'Run command',
      permission_suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' },
      ],
    });
    if (decision.cancelled) return; // interrupt already ended the turn
    if (decision.behavior === 'allow') {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file.txt' }] }, tool_use_result: { stdout: 'file.txt', stderr: '' }, parent_tool_use_id: null, ...base() });
      say(`allowed:${JSON.stringify(decision.updatedInput)}:${JSON.stringify(decision.updatedPermissions ?? null)}`);
    } else {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: decision.message, is_error: true }] }, parent_tool_use_id: null, ...base() });
      say(`denied:${decision.message}`);
    }
    return;
  }

  if (text === 'ask') {
    const input = { questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'SQLite' }], multiSelect: false }] };
    out({ type: 'assistant', message: { id: 'msg_ask', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input }] }, parent_tool_use_id: null, ...base() });
    const decision = await askPermission({ tool_name: 'AskUserQuestion', input, tool_use_id: 'toolu_ask', permission_suggestions: [] });
    if (decision.cancelled) return;
    say(`answers:${JSON.stringify(decision.updatedInput?.answers ?? null)}`);
    return;
  }

  if (text === 'sub') {
    out({ type: 'assistant', message: { id: 'msg_task', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'Explore repo', subagent_type: 'Explore' } }] }, parent_tool_use_id: null, ...base() });
    out({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'toolu_task', description: 'Explore repo', subagent_type: 'Explore', ...base() });
    out({ type: 'assistant', message: { id: 'msg_sub', role: 'assistant', content: [{ type: 'text', text: 'Looking around' }, { type: 'tool_use', id: 'toolu_sub_read', name: 'Read', input: { file_path: 'README.md' } }] }, parent_tool_use_id: 'toolu_task', ...base() });
    out({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'toolu_task', status: 'completed', ...base() });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'Found it' }] }, parent_tool_use_id: null, ...base() });
    result('sub done');
    return;
  }

  if (text === 'limit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1760000000, utilization: 0.91 }, ...base() });
    result('limited');
    return;
  }

  if (text === 'novel') {
    out({ type: 'system', subtype: 'brand_new_thing', detail: 42, ...base() });
    result('novel');
    return;
  }

  if (text === 'quit') {
    // Large enough that the parent sees 'exit' before it has read all of stdout.
    const big = 'x'.repeat(512 * 1024);
    const lines = [
      { type: 'assistant', message: { id: 'msg_quit', role: 'assistant', content: [{ type: 'text', text: big }] }, parent_tool_use_id: null, ...base() },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: 'bye', ...base() },
    ];
    process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', () => process.exit(0));
    return;
  }

  if (text === 'crash') {
    process.stderr.write('fake claude: crashing on request\n');
    process.exit(3);
  }

  result(`echo:${text}|priority:${msg.priority ?? 'none'}|shouldQuery:${msg.shouldQuery ?? 'unset'}`);
}

function respond(requestId, response) {
  out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

function onControlRequest(msg) {
  const { request_id: id, request } = msg;
  switch (request.subtype) {
    case 'initialize':
      respond(id, {
        commands: [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>' }],
        models: [{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku' }],
        agents: [],
        claude_code_version: '2.1.300-fake',
        current_permission_mode: permissionMode,
        pid: process.pid,
      });
      return;
    case 'set_permission_mode':
      permissionMode = request.mode;
      respond(id, {});
      out({ type: 'system', subtype: 'status', status: null, permissionMode, ...base() });
      return;
    case 'set_model':
      model = request.model ?? 'claude-fake-1';
      respond(id, {});
      return;
    case 'interrupt':
      respond(id, {});
      for (const [reqId, resolve] of pendingPermissions) {
        pendingPermissions.delete(reqId);
        out({ type: 'control_cancel_request', request_id: reqId });
        resolve({ cancelled: true });
        result('', { subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] });
      }
      return;
    default:
      // The SDK may send setup requests this fake doesn't model; accept them.
      process.stderr.write(`fake claude: accepting unmodeled control request ${request.subtype}\n`);
      respond(id, {});
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') return onControlRequest(msg);
  if (msg.type === 'control_response') {
    const resolve = pendingPermissions.get(msg.response.request_id);
    if (resolve) {
      pendingPermissions.delete(msg.response.request_id);
      resolve(msg.response.response);
    }
    return;
  }
  if (msg.type !== 'user') return;
  if (turnInFlight && msg.priority !== 'later') {
    const content = msg.message?.content;
    steered.push(typeof content === 'string' ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    return;
  }
  if (msg.priority === 'later' && turnInFlight) {
    const prev = turnInFlight;
    turnInFlight = prev.then(() => runTurn(msg));
    return;
  }
  turnInFlight = runTurn(msg).finally(() => { turnInFlight = null; });
});
rl.on('close', () => process.exit(0));
