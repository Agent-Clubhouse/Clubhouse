/**
 * Scripted chat turns for the fake CLI (#2480): build a fixture from a list
 * of turns instead of recording one, for the rich content and chat UX specs.
 * Paths and image bytes are only known when the test runs (a temp project, a
 * file outside it), so scripts are built per test and written to a temp dir;
 * nothing built here is committed.
 *
 * Each script starts with the handshake of a committed fixture (everything
 * before its first prompt, `multi-turn` by default), so the opening exchange
 * stays the one the replay tests already cover. Turns are appended in the
 * protocol's own shapes:
 *
 * - Claude stream-json: `assistant` messages, `tool_use` and `tool_result`
 *   blocks, `can_use_tool` control requests, one `result` per turn, and
 *   mid-turn `user` messages (steers) on held turns.
 * - Codex app-server: `turn/start`, `item/*` notifications, `turn/completed`.
 * - Copilot SDK: `session.send` (with `mode: "immediate"` for a steer),
 *   `session.event` notifications in the recorded shapes (copilot-sdk/), the
 *   permission round trip and `session.abort`.
 *
 * Shapes no capture backs are listed in the header's `synthesized` field, as
 * for hand-made fixtures (docs/chat-fixtures.md).
 *
 * Test-only: production code must not import this module.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CHAT_FIXTURES_DIR, chatFixturePath, type ChatFixtureCli } from './fake-cli';

/** Committed media for chat E2E (scripts/chat-fixtures/make-media.mjs). */
export const CHAT_MEDIA_DIR = path.join(CHAT_FIXTURES_DIR, '..', 'chat-media');

export const CHAT_MEDIA = {
  png: path.join(CHAT_MEDIA_DIR, 'tiny.png'),
  pdf: path.join(CHAT_MEDIA_DIR, 'two-pages.pdf'),
  wav: path.join(CHAT_MEDIA_DIR, 'tone.wav'),
  webm: path.join(CHAT_MEDIA_DIR, 'clip.webm'),
} as const;

/** An image a tool returns: a file whose bytes are read when the script is built. */
export interface ScriptImage {
  path: string;
  mimeType: string;
}

/**
 * How a tool's image reaches the driver, per provider:
 * - Claude: `content` (an image block in the tool_result, the default) or
 *   `read-result` (Read's `tool_use_result.file.base64`, no image block).
 * - Codex: `view` (an `imageView` item naming the file, the default) or
 *   `generated` (an `imageGeneration` item with base64 `result`).
 * - Copilot: none. The SDK driver shows no image from a tool's result.
 */
export type ImageVariant = 'content' | 'read-result' | 'view' | 'generated';

export interface ScriptQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

export type ScriptStep =
  /** Assistant Markdown (see `md` for paths and images). */
  | { type: 'text'; text: string }
  /** A tool call whose result carries an image. */
  | { type: 'image-tool'; image: ScriptImage; variant?: ImageVariant }
  /** A shell command that ran and printed `output` (Claude Bash, Codex commandExecution). */
  | { type: 'command'; command: string; output: string }
  /**
   * AskUserQuestion (Claude only): the questions reach the dock as a
   * permission request, and the fixture waits for exactly `answers`
   * (keyed by question text, multiSelect labels joined with ", ").
   */
  | { type: 'questions'; questions: ScriptQuestion[]; answers: Record<string, string> }
  /**
   * A tool call that asks for approval before it runs; the fixture waits for
   * an allow, so a denial fails the replay.
   */
  | { type: 'approval'; approval: ScriptApproval };

/**
 * A tool call that needs the user's approval (see the `approval` step).
 * Claude asks for any tool; Codex and Copilot for a shell command, so they
 * need `input.command`.
 */
export interface ScriptApproval {
  /** Claude: the tool name (Bash, Edit, ...). Codex and Copilot run `input.command`. */
  tool: string;
  input: Record<string, unknown>;
  /**
   * The request's title: Claude's `can_use_tool` title, Copilot's tool call
   * title. Codex has none; the app titles it "Run <command>".
   */
  title?: string;
  /** Why it asks: Claude's description, Codex's `reason`, the `description` argument of Copilot's bash call. */
  description?: string;
  /** The tool's result once approved. Default: "Done." */
  result?: string;
}

export interface ScriptTurn {
  /** What the prompt says. For readability only unless `pinPrompt`: replay matches the method, not the text. */
  prompt?: string;
  /**
   * The CLI must receive exactly `prompt` (a text-only message). Pins which
   * message a turn the client started from its queue carried.
   */
  pinPrompt?: boolean;
  steps: ScriptStep[];
  /**
   * `end_turn` (default) finishes the turn. `held` leaves it running on a
   * shell command until the client stops it (Stop, or a provider's own
   * interrupt), then ends it as cancelled: a turn that stays busy for as
   * long as a test needs, to fill the queue or the dock.
   */
  end?: 'end_turn' | 'held';
  /**
   * Held turns only: messages the CLI takes while the turn runs, in the
   * order they must arrive, before the Stop that ends it. These are what
   * Steer, Claude's Queue and a parent's helper updates send mid-turn.
   * Anything else that arrives mid-turn is a mismatch.
   */
  steers?: ScriptSteer[];
}

/** A message sent into a running turn: a Claude `user` with a `priority`, a Codex `turn/steer`, or a Copilot `session.send` with `mode: "immediate"`. */
export interface ScriptSteer {
  /**
   * `next` (default) steers at the next tool boundary; `later` (Claude only)
   * is Claude's own queue for the next turn.
   */
  priority?: 'next' | 'later';
  /** Exactly what the CLI must receive; leave it out to take any text. */
  text?: string;
}

export interface ChatScript {
  description: string;
  turns: ScriptTurn[];
  /** Committed fixture whose handshake the script starts with. */
  base?: string;
}

type Entry = Record<string, unknown>;

export interface BuiltChatScript {
  cli: ChatFixtureCli;
  /** Header first, then entries in wire order. */
  lines: Entry[];
  /** The session id the handshake hands out (Claude `session_id`, Codex thread id, Copilot `sessionId`). */
  sessionId: string;
}

/** Markdown snippets for `text` steps. */
export const md = {
  /** A path as a code span, optionally with `:line[:col]`: the strongest chip candidate. */
  path(p: string, line?: number, col?: number): string {
    const loc = line === undefined ? '' : col === undefined ? `:${line}` : `:${line}:${col}`;
    return `\`${p}${loc}\``;
  },
  /** A path in double quotes in prose, Markdown-escaped so Windows backslashes stay (`\\_temp` would lose one). */
  quotedPath(p: string): string {
    return `"${p.replace(/[\\`*_~&[\]<>]/g, '\\$&')}"`;
  },
  /** A local image as a `file:` URL, which reads the same on every OS. */
  image(alt: string, p: string): string {
    return `![${alt}](${pathToFileURL(p).href})`;
  },
};

function readBaseFixture(cli: ChatFixtureCli, name: string): Entry[] {
  return fs.readFileSync(chatFixturePath(cli, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Entry);
}

const msgOf = (e: Entry): Entry | undefined => (e.msg && typeof e.msg === 'object' ? e.msg as Entry : undefined);

function isPrompt(cli: ChatFixtureCli, e: Entry): boolean {
  const m = e.from === 'client' ? msgOf(e) : undefined;
  if (!m) return false;
  if (cli === 'claude') return m.type === 'user';
  return m.method === (cli === 'codex' ? 'turn/start' : 'session.send');
}

/** Header, handshake entries, and what the turns need from them. */
function handshake(cli: ChatFixtureCli, base: string) {
  const entries = readBaseFixture(cli, base);
  const header = entries[0];
  if (header?.kind !== 'header') throw new Error(`${cli}/${base} has no header`);
  const firstPrompt = entries.findIndex((e) => isPrompt(cli, e));
  if (firstPrompt < 0) throw new Error(`${cli}/${base} has no prompt to cut the handshake at`);
  const prefix = entries.slice(1, firstPrompt);
  const cliMsgs = entries.filter((e) => e.from === 'cli').map(msgOf).filter((m): m is Entry => !!m);
  let sessionId: string | undefined;
  let claudeInit: Entry | undefined;
  if (cli === 'claude') {
    claudeInit = cliMsgs.find((m) => m.type === 'system' && m.subtype === 'init');
    sessionId = claudeInit?.session_id as string | undefined;
  } else if (cli === 'codex') {
    sessionId = cliMsgs.map((m) => (m.result as { thread?: { id?: string } } | undefined)?.thread?.id).find(Boolean);
  } else {
    sessionId = cliMsgs.map((m) => (m.result as { sessionId?: string } | undefined)?.sessionId).find(Boolean);
  }
  if (!sessionId) throw new Error(`${cli}/${base}: no session id in the handshake`);
  const ids = prefix.map((e) => msgOf(e)?.id).filter((id): id is number => typeof id === 'number');
  return { header, prefix, sessionId, claudeInit, nextId: Math.max(0, ...ids) + 1 };
}

function imageBytes(image: ScriptImage): { data: string; byteLength: number } {
  const bytes = fs.readFileSync(image.path);
  return { data: bytes.toString('base64'), byteLength: bytes.length };
}

const cliEntry = (msg: Entry): Entry => ({ from: 'cli', msg });
const clientEntry = (msg: Entry, match?: Entry): Entry => ({ from: 'client', msg, ...(match && { match }) });

/** Build `script` for `cli`. Throws on a step the provider has no shape for. */
export function buildChatScript(cli: ChatFixtureCli, script: ChatScript): BuiltChatScript {
  if (cli !== 'claude' && script.turns.some((t) => t.steers?.some((st) => st.priority === 'later'))) unsupported(cli, 'later steer');
  if (script.turns.some((t) => t.pinPrompt && t.prompt === undefined)) throw new Error('chat-script: pinPrompt needs a prompt');
  if (script.turns.some((t) => t.steers?.length && t.end !== 'held')) throw new Error('chat-script: steers need a held turn');
  const hs = handshake(cli, script.base ?? 'multi-turn');
  const synthesized = new Set<string>();
  const out: Entry[] = [...hs.prefix];
  const build = { claude: claudeTurn, codex: codexTurn, copilot: copilotTurn }[cli];
  const ctx: TurnContext = { sessionId: hs.sessionId, nextId: hs.nextId, seq: 0, synthesized, claudeInit: hs.claudeInit, cliRequestId: 0 };
  script.turns.forEach((turn, i) => out.push(...build(turn, i, ctx)));
  const header: Entry = {
    ...hs.header,
    source: 'hand-made',
    description: `Built by chat-script.ts: ${script.description}`,
    ...(synthesized.size && { synthesized: [...synthesized] }),
  };
  delete header.recordedAt;
  return { cli, lines: [header, ...out], sessionId: hs.sessionId };
}

/** Write a built script to `<dir>/<name>.jsonl`. */
export async function writeChatScript(dir: string, name: string, built: BuiltChatScript): Promise<{ fixture: string }> {
  await fs.promises.mkdir(dir, { recursive: true });
  const fixture = path.join(dir, `${name}.jsonl`);
  await fs.promises.writeFile(fixture, built.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { fixture };
}

interface TurnContext {
  sessionId: string;
  nextId: number;
  /** Counter for unique message, tool and item ids across the script. */
  seq: number;
  synthesized: Set<string>;
  claudeInit?: Entry;
  /** Ids of requests the CLI sends (Codex approvals), from 0 as the fixtures number them. */
  cliRequestId: number;
}

function unsupported(cli: string, what: string): never {
  throw new Error(`chat-script: ${cli} has no ${what} shape yet`);
}

/** The shell command a Codex or Copilot approval runs. */
function approvalCommand(cli: string, approval: ScriptApproval): string {
  const command = approval.input.command;
  if (typeof command !== 'string') unsupported(cli, 'approval without input.command');
  return command;
}

// ── Claude stream-json ──────────────────────────────────────────────────────

function claudeTurn(turn: ScriptTurn, index: number, ctx: TurnContext): Entry[] {
  const sid = ctx.sessionId;
  const uuid = () => `00000000-0000-4000-8000-${String(900000000000 + ++ctx.seq).padStart(12, '0')}`;
  const usage = { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4, service_tier: 'standard' };
  const assistant = (content: Entry[]): Entry => cliEntry({
    type: 'assistant',
    message: { model: 'claude-haiku-5-5', id: `msg_script_${++ctx.seq}`, type: 'message', role: 'assistant', content, stop_reason: null, stop_sequence: null, usage },
    parent_tool_use_id: null, session_id: sid, uuid: uuid(),
  });
  const toolResult = (toolUseId: string, content: unknown, extra: Entry = {}): Entry => cliEntry({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(extra.is_error ? { is_error: true } : {}) }] },
    parent_tool_use_id: null, session_id: sid, uuid: uuid(),
    ...(extra.tool_use_result !== undefined && { tool_use_result: extra.tool_use_result }),
  });
  // The driver sends text-only content as a plain string (toWireUserMessage), which a pinned prompt matches.
  const content = turn.pinPrompt ? turn.prompt : [{ type: 'text', text: turn.prompt ?? `Turn ${index + 1}.` }];
  const out: Entry[] = [clientEntry(
    { type: 'user', session_id: '', message: { role: 'user', content }, parent_tool_use_id: null },
    turn.pinPrompt ? { message: { content: turn.prompt } } : undefined,
  )];
  if (index === 0 && ctx.claudeInit) out.push(cliEntry({ ...ctx.claudeInit, uuid: uuid() }));
  let lastText = '';
  for (const step of turn.steps) {
    if (step.type === 'text') {
      out.push(assistant([{ type: 'text', text: step.text }]));
      lastText = step.text;
    } else if (step.type === 'image-tool') {
      const variant = step.variant ?? 'content';
      if (variant !== 'content' && variant !== 'read-result') unsupported('claude', `${variant} image`);
      const id = `toolu_script_${++ctx.seq}`;
      const img = imageBytes(step.image);
      out.push(assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: step.image.path } }]));
      if (variant === 'content') {
        out.push(toolResult(id, [{ type: 'image', source: { type: 'base64', media_type: step.image.mimeType, data: img.data } }]));
      } else {
        ctx.synthesized.add('Read tool_use_result { type: "image", file: { base64, type } } with no image block');
        out.push(toolResult(id, 'Read image', { tool_use_result: { type: 'image', file: { base64: img.data, type: step.image.mimeType, originalSize: img.byteLength } } }));
      }
    } else if (step.type === 'command') {
      const id = `toolu_script_${++ctx.seq}`;
      ctx.synthesized.add('Bash tool_use_result { stdout, stderr, interrupted, isImage }: no committed capture of a Bash run');
      out.push(assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: step.command, description: 'Run a command' } }]));
      out.push(toolResult(id, step.output, { tool_use_result: { stdout: step.output, stderr: '', interrupted: false, isImage: false } }));
    } else if (step.type === 'approval') {
      const { tool, input, title, description, result: said = 'Done.' } = step.approval;
      const id = `toolu_script_${++ctx.seq}`;
      const requestId = `perm-script-${ctx.seq}`;
      ctx.synthesized.add('can_use_tool title and description text, and a plain-text tool_result (fields as claude/permission-approve-edit)');
      out.push(assistant([{ type: 'tool_use', id, name: tool, input }]));
      out.push(cliEntry({
        type: 'control_request', request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: id, permission_suggestions: [], ...(title && { title }), ...(description && { description }) },
      }));
      // As claude/permission-approve-edit: allow echoes the input back as updatedInput.
      out.push(clientEntry(
        { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } } },
        { response: { request_id: requestId, response: { behavior: 'allow' } } },
      ));
      out.push(toolResult(id, said));
    } else {
      const id = `toolu_script_${++ctx.seq}`;
      const requestId = `perm-script-${ctx.seq}`;
      const input = { questions: step.questions.map((q) => ({ multiSelect: false, ...q, options: q.options.map((o) => ({ description: '', ...o })) })) };
      ctx.synthesized.add('AskUserQuestion updatedInput.answers format and tool_result text (as claude/ask-user-question)');
      out.push(assistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input }]));
      out.push(cliEntry({
        type: 'control_request', request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: id, permission_suggestions: [], title: 'Claude has questions for you', display_name: 'AskUserQuestion', requires_user_interaction: true },
      }));
      out.push(clientEntry(
        { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: { ...input, answers: { ...step.answers } } } } },
        { response: { request_id: requestId, response: { behavior: 'allow', updatedInput: { answers: { ...step.answers } } } } },
      ));
      const said = Object.entries(step.answers).map(([q, a]) => `"${q}"="${a}"`).join(', ');
      out.push(toolResult(id, `User has answered your questions: ${said}. You can now continue with the user's answers in mind.`, { tool_use_result: { ...input, answers: { ...step.answers } } }));
    }
  }
  const result = (subtype: string, stopReason: string | null): Entry => cliEntry({
    type: 'result', subtype, is_error: false, duration_ms: 1000, duration_api_ms: 800, num_turns: index + 1, result: lastText,
    stop_reason: stopReason, session_id: sid, uuid: uuid(), total_cost_usd: 0, usage, permission_denials: [], queued_turn_count: 0,
  });
  if ((turn.end ?? 'end_turn') === 'end_turn') {
    out.push(result('success', 'end_turn'));
    return out;
  }
  // Held: a shell command that runs until the client interrupts (as claude/interrupt).
  const id = `toolu_script_${++ctx.seq}`;
  out.push(assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 600', description: 'Wait' } }]));
  if (turn.steers?.length) ctx.synthesized.add('mid-turn user messages with priority next/later, matched on priority and text');
  for (const steer of turn.steers ?? []) {
    const priority = steer.priority ?? 'next';
    const message = { role: 'user', content: steer.text ?? `Steer ${++ctx.seq}.` };
    out.push(clientEntry(
      { type: 'user', message, parent_tool_use_id: null, session_id: sid, priority },
      { priority, ...(steer.text !== undefined && { message: { content: steer.text } }) },
    ));
  }
  out.push(clientEntry({ type: 'control_request', request_id: 'req_interrupt', request: { subtype: 'interrupt' } }));
  out.push(cliEntry({ type: 'control_response', response: { subtype: 'success', request_id: 'req_interrupt', response: { still_queued: [] } } }));
  out.push(toolResult(id, 'Interrupted by user', { is_error: true, tool_use_result: 'Error: Interrupted by user' }));
  out.push(cliEntry({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null, session_id: sid, uuid: uuid() }));
  out.push(result('error_during_execution', null));
  return out;
}

// ── Codex app-server ────────────────────────────────────────────────────────

function codexTurn(turn: ScriptTurn, index: number, ctx: TurnContext): Entry[] {
  const threadId = ctx.sessionId;
  const turnId = `019a0000-0000-7000-8000-scr${String(index + 1).padStart(9, '0')}`;
  const turnObj = (status: string): Entry => ({ id: turnId, items: [], itemsView: 'full', status, error: null, startedAt: 1792180000, completedAt: status === 'inProgress' ? null : 1792180001, durationMs: status === 'inProgress' ? null : 1000 });
  const item = (method: 'item/started' | 'item/completed', it: Entry) => cliEntry({ method, params: { item: it, threadId, turnId } });
  const id = ctx.nextId++;
  const out: Entry[] = [
    clientEntry(
      { id, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: turn.prompt ?? `Turn ${index + 1}.`, text_elements: [] }] } },
      turn.pinPrompt ? { params: { input: [{ type: 'text', text: turn.prompt }] } } : undefined,
    ),
    cliEntry({ id, result: { turn: turnObj('inProgress') } }),
    cliEntry({ method: 'turn/started', params: { threadId, turn: turnObj('inProgress') } }),
  ];
  for (const step of turn.steps) {
    const itemId = `item_script_${++ctx.seq}`;
    if (step.type === 'text') {
      const msg: Entry = { type: 'agentMessage', id: itemId, text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
      out.push(item('item/started', msg), item('item/completed', { ...msg, text: step.text }));
    } else if (step.type === 'image-tool') {
      const variant = step.variant ?? 'view';
      ctx.synthesized.add('imageView / imageGeneration items: fields from the generated v2 schema, no capture');
      if (variant === 'view') {
        const view = { type: 'imageView', id: itemId, path: step.image.path };
        out.push(item('item/started', view), item('item/completed', view));
      } else if (variant === 'generated') {
        const gen: Entry = { type: 'imageGeneration', id: itemId, status: 'inProgress', revisedPrompt: null, result: '', failure: null };
        out.push(item('item/started', gen), item('item/completed', { ...gen, status: 'completed', revisedPrompt: 'A small gradient', result: imageBytes(step.image).data }));
      } else {
        unsupported('codex', `${variant} image`);
      }
    } else if (step.type === 'command') {
      ctx.synthesized.add('commandExecution completed with exit 0 (fields as codex/interrupt)');
      const cmd: Entry = { type: 'commandExecution', id: `call_script_${ctx.seq}`, pluginId: null, scriptPath: null, command: `/bin/sh -lc '${step.command}'`, cwd: '/workspace/project', processId: '4242', source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: step.command }], aggregatedOutput: null, exitCode: null, durationMs: null };
      out.push(item('item/started', cmd), item('item/completed', { ...cmd, status: 'completed', aggregatedOutput: step.output, exitCode: 0, durationMs: 100 }));
    } else if (step.type === 'approval') {
      // As codex/permission-deny, with an accept.
      const command = approvalCommand('codex', step.approval);
      const requestId = ctx.cliRequestId++;
      const actions = [{ type: 'unknown', command }];
      const cmd: Entry = { type: 'commandExecution', id: itemId, command: `/bin/sh -lc '${command.replace(/'/g, `'\\''`)}'`, cwd: '/workspace/project', processId: null, source: 'agent', status: 'inProgress', commandActions: actions, aggregatedOutput: null, exitCode: null, durationMs: null };
      out.push(
        item('item/started', cmd),
        cliEntry({ id: requestId, method: 'item/commandExecution/requestApproval', params: {
          kind: 'command', threadId, turnId, itemId, startedAtMs: 1792180000500, approvalId: null, environmentId: null,
          reason: step.approval.description ?? null, command, cwd: '/workspace/project', commandActions: actions,
          availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        } }),
        clientEntry({ id: requestId, result: { decision: 'accept' } }, { id: requestId, result: { decision: 'accept' } }),
        cliEntry({ method: 'serverRequest/resolved', params: { threadId, requestId } }),
        item('item/completed', { ...cmd, status: 'completed', aggregatedOutput: step.approval.result ?? 'Done.', exitCode: 0, durationMs: 1000 }),
      );
    } else {
      unsupported('codex', 'question');
    }
  }
  if ((turn.end ?? 'end_turn') === 'end_turn') {
    out.push(cliEntry({ method: 'turn/completed', params: { threadId, turn: turnObj('completed') } }));
    return out;
  }
  // Held (as codex/interrupt).
  const cmdId = `call_script_${++ctx.seq}`;
  const cmd: Entry = { type: 'commandExecution', id: cmdId, command: "/bin/sh -lc 'sleep 600'", cwd: '/workspace/project', processId: '4242', source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'sleep 600' }], aggregatedOutput: null, exitCode: null, durationMs: null };
  out.push(item('item/started', cmd));
  if (turn.steers?.length) ctx.synthesized.add('turn/steer requests and responses: fields from the generated v2 schema, matched on input text');
  for (const steer of turn.steers ?? []) {
    const steerId = ctx.nextId++;
    const input = [{ type: 'text', text: steer.text ?? `Steer ${++ctx.seq}.`, text_elements: [] as unknown[] }];
    out.push(
      clientEntry({ id: steerId, method: 'turn/steer', params: { threadId, input, expectedTurnId: turnId } }, steer.text !== undefined ? { params: { input: [{ type: 'text', text: steer.text }] } } : undefined),
      cliEntry({ id: steerId, result: { turnId } }),
    );
  }
  const stopId = ctx.nextId++;
  out.push(
    clientEntry({ id: stopId, method: 'turn/interrupt', params: { threadId, turnId } }, { params: { turnId } }),
    cliEntry({ id: stopId, result: {} }),
    item('item/completed', { ...cmd, status: 'failed', aggregatedOutput: '', durationMs: 1000 }),
    cliEntry({ method: 'turn/completed', params: { threadId, turn: turnObj('interrupted') } }),
  );
  return out;
}

// ── Copilot SDK ─────────────────────────────────────────────────────────────

/** A Copilot session event, as the CLI sends one (copilot-sdk/ recordings). */
function copilotEvent(ctx: TurnContext, type: string, data: Entry, ephemeral = false): Entry {
  const n = ++ctx.seq;
  return cliEntry({
    jsonrpc: '2.0',
    method: 'session.event',
    params: {
      sessionId: ctx.sessionId,
      event: {
        type,
        data,
        id: `00000000-0000-4000-8000-${String(800000000000 + n).padStart(12, '0')}`,
        timestamp: new Date(Date.UTC(2026, 10, 1) + n).toISOString(),
        parentId: null,
        ...(ephemeral && { ephemeral: true }),
      },
    },
  });
}

function copilotTurn(turn: ScriptTurn, index: number, ctx: TurnContext): Entry[] {
  const sessionId = ctx.sessionId;
  const ev = (type: string, data: Entry, ephemeral = false) => copilotEvent(ctx, type, data, ephemeral);
  const id = ctx.nextId++;
  const prompt = turn.prompt ?? `Turn ${index + 1}.`;
  const messageId = `00000000-0000-4000-8000-${String(700000000000 + ++ctx.seq).padStart(12, '0')}`;
  const interactionId = `00000000-0000-4000-8000-${String(600000000000 + ++ctx.seq).padStart(12, '0')}`;
  const turnId = '0';
  // As copilot-sdk/multi-turn: the send is answered with the message id, then the turn runs.
  const out: Entry[] = [
    clientEntry(
      { jsonrpc: '2.0', id, method: 'session.send', params: { sessionId, prompt } },
      turn.pinPrompt ? { params: { prompt } } : undefined,
    ),
    cliEntry({ jsonrpc: '2.0', id, result: { messageId } }),
    ev('user.message', { content: prompt, messageId, delivery: 'idle', interactionId, turnId }),
    ev('assistant.turn_start', { turnId, interactionId }),
  ];
  for (const step of turn.steps) {
    if (step.type === 'text') {
      const msg = `msg_script_${++ctx.seq}`;
      out.push(
        ev('assistant.message_delta', { messageId: msg, deltaContent: step.text }, true),
        ev('assistant.message', { messageId: msg, originatingMessageId: messageId, content: step.text, toolRequests: [], interactionId, turnId }),
      );
    } else if (step.type === 'approval') {
      // As copilot-sdk/permission-deny, with an approve-once.
      const command = approvalCommand('copilot', step.approval);
      const toolCallId = `call_script_${++ctx.seq}`;
      const requestId = `00000000-0000-4000-8000-${String(500000000000 + ++ctx.seq).padStart(12, '0')}`;
      const intention = step.approval.title ?? step.approval.description ?? `Run ${command}`;
      const args = { command, ...(step.approval.description && { description: step.approval.description }), mode: 'sync' };
      out.push(
        ev('tool.execution_start', { toolCallId, toolName: 'bash', arguments: args, turnId, toolTitle: 'Running command' }),
        ev('permission.requested', { requestId, permissionRequest: { kind: 'shell', toolCallId, fullCommandText: command, shellType: 'bash', intention, commands: [{ identifier: command, readOnly: false }] } }),
        clientEntry(
          { jsonrpc: '2.0', id: ctx.nextId++, method: 'session.permissions.handlePendingPermissionRequest', params: { requestId, result: { kind: 'approve-once' }, sessionId } },
          { params: { result: { kind: 'approve-once' } } },
        ),
        ev('permission.completed', { requestId, toolCallId, result: { kind: 'approved' } }),
        cliEntry({ jsonrpc: '2.0', id: ctx.nextId - 1, result: { success: true } }),
        ev('tool.execution_complete', { toolCallId, interactionId, turnId, success: true, result: { content: step.approval.result ?? 'Done.' } }),
      );
    } else {
      unsupported('copilot', step.type === 'image-tool' ? 'image tool' : step.type === 'command' ? 'command' : 'question');
    }
  }
  out.push(ev('assistant.usage', { model: 'fake-model', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, true));
  if ((turn.end ?? 'end_turn') === 'end_turn') {
    out.push(ev('assistant.turn_end', { turnId }), ev('session.idle', { mode: 'interactive' }, true));
    return out;
  }
  // Held (as copilot-sdk/interrupt, on a tool instead of a model call): a long
  // command runs until the client aborts. Steers arrive while it runs.
  const toolCallId = `call_script_${++ctx.seq}`;
  out.push(ev('tool.execution_start', { toolCallId, toolName: 'bash', arguments: { command: 'sleep 600', mode: 'sync' }, turnId, toolTitle: 'Running command' }));
  for (const steer of turn.steers ?? []) {
    const steerId = ctx.nextId++;
    out.push(
      clientEntry(
        { jsonrpc: '2.0', id: steerId, method: 'session.send', params: { sessionId, prompt: steer.text ?? 'Steer.', mode: 'immediate' } },
        { params: { mode: 'immediate', ...(steer.text !== undefined && { prompt: steer.text }) } },
      ),
      cliEntry({ jsonrpc: '2.0', id: steerId, result: { messageId: `00000000-0000-4000-8000-${String(400000000000 + ++ctx.seq).padStart(12, '0')}` } }),
    );
  }
  const abortId = ctx.nextId++;
  ctx.synthesized.add('tool.execution_complete for a command the abort cancelled');
  out.push(
    clientEntry({ jsonrpc: '2.0', id: abortId, method: 'session.abort', params: { sessionId } }),
    ev('abort', { reason: 'user_initiated' }),
    ev('tool.execution_complete', { toolCallId, interactionId, turnId, success: false, error: { message: 'The user cancelled the operation.', code: 'aborted' } }),
    ev('assistant.turn_end', { turnId }),
    cliEntry({ jsonrpc: '2.0', id: abortId, result: { success: true } }),
    ev('session.idle', { aborted: true, mode: 'interactive' }, true),
  );
  return out;
}
