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
 * - Copilot ACP: `session/prompt`, `session/update` notifications, and for
 *   images `rawOutput.binaryResultsForLlm` with the bytes in a session-state
 *   journal (`<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`), the way
 *   Copilot itself keeps them (copilot-assets.ts).
 *
 * Shapes no capture backs are listed in the header's `synthesized` field, as
 * for hand-made fixtures (docs/chat-fixtures.md).
 *
 * Test-only: production code must not import this module.
 */
import { createHash } from 'crypto';
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
 * - Copilot: `asset` (a `binaryResultsForLlm` asset id, bytes in the session
 *   journal, the default), `inline` (base64 `data` in the binary result) or
 *   `omitted` (an `omittedReason` and no bytes).
 */
export type ImageVariant = 'content' | 'read-result' | 'view' | 'generated' | 'asset' | 'inline' | 'omitted';

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
  /** Why it asks: Claude's description, Codex's `reason`, Copilot's `rawInput.description`. */
  description?: string;
  /** The tool's result once approved. Default: "Done." */
  result?: string;
}

export interface ScriptTurn {
  /** What the prompt says, for readability only: replay matches the method, not the text. */
  prompt?: string;
  steps: ScriptStep[];
  /**
   * `end_turn` (default) finishes the turn. `held` leaves it running on a
   * shell command until the client stops it (Stop, or a provider's own
   * interrupt), then ends it as cancelled: a turn that stays busy for as
   * long as a test needs, to fill the queue or the dock.
   */
  end?: 'end_turn' | 'held';
  /**
   * Claude, held turns only: messages the CLI takes while the turn runs, in
   * the order they must arrive, before the Stop that ends it. Claude steers
   * natively, so these are what Steer, Queue and a parent's helper updates
   * send mid-turn. Anything else that arrives mid-turn is a mismatch.
   */
  steers?: ScriptSteer[];
}

/** A message sent into a running Claude turn (stream-json `user` with a `priority`). */
export interface ScriptSteer {
  /** `next` (default) steers at the next tool boundary; `later` is Claude's own queue for the next turn. */
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
  /** The session id the handshake hands out (Claude `session_id`, Codex thread id, ACP `sessionId`). */
  sessionId: string;
  /** Copilot only: the session journal lines its binary assets need. */
  copilotJournal: Entry[];
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
  return m.method === (cli === 'codex' ? 'turn/start' : 'session/prompt');
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

function imageBytes(image: ScriptImage): { data: string; byteLength: number; assetId: string } {
  const bytes = fs.readFileSync(image.path);
  return { data: bytes.toString('base64'), byteLength: bytes.length, assetId: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}

const cliEntry = (msg: Entry): Entry => ({ from: 'cli', msg });
const clientEntry = (msg: Entry, match?: Entry): Entry => ({ from: 'client', msg, ...(match && { match }) });

/** Build `script` for `cli`. Throws on a step the provider has no shape for. */
export function buildChatScript(cli: ChatFixtureCli, script: ChatScript): BuiltChatScript {
  if (cli !== 'claude' && script.turns.some((t) => t.steers?.length)) unsupported(cli, 'steer');
  if (script.turns.some((t) => t.steers?.length && t.end !== 'held')) throw new Error('chat-script: steers need a held turn');
  const hs = handshake(cli, script.base ?? 'multi-turn');
  const synthesized = new Set<string>();
  const journal: Entry[] = [];
  const out: Entry[] = [...hs.prefix];
  const build = { claude: claudeTurn, codex: codexTurn, copilot: copilotTurn }[cli];
  const ctx: TurnContext = { sessionId: hs.sessionId, nextId: hs.nextId, seq: 0, synthesized, journal, claudeInit: hs.claudeInit, cliRequestId: 0 };
  script.turns.forEach((turn, i) => out.push(...build(turn, i, ctx)));
  const header: Entry = {
    ...hs.header,
    source: 'hand-made',
    description: `Built by chat-script.ts: ${script.description}`,
    ...(synthesized.size && { synthesized: [...synthesized] }),
  };
  delete header.recordedAt;
  return { cli, lines: [header, ...out], sessionId: hs.sessionId, copilotJournal: journal };
}

/**
 * Write a built script to `<dir>/<name>.jsonl`. For Copilot, also write its
 * session journal under `<dir>/copilot-home`; pass that as COPILOT_HOME.
 */
export async function writeChatScript(dir: string, name: string, built: BuiltChatScript): Promise<{ fixture: string; copilotHome?: string }> {
  await fs.promises.mkdir(dir, { recursive: true });
  const fixture = path.join(dir, `${name}.jsonl`);
  await fs.promises.writeFile(fixture, built.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (built.cli !== 'copilot') return { fixture };
  const copilotHome = path.join(dir, 'copilot-home');
  const sessionDir = path.join(copilotHome, 'session-state', built.sessionId);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, 'events.jsonl'), built.copilotJournal.map((l) => JSON.stringify(l)).join('\n') + (built.copilotJournal.length ? '\n' : ''));
  return { fixture, copilotHome };
}

interface TurnContext {
  sessionId: string;
  nextId: number;
  /** Counter for unique message, tool and item ids across the script. */
  seq: number;
  synthesized: Set<string>;
  journal: Entry[];
  claudeInit?: Entry;
  /** Ids of requests the CLI sends (Codex and Copilot approvals), from 0 as the fixtures number them. */
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
  const out: Entry[] = [clientEntry({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: turn.prompt ?? `Turn ${index + 1}.` }] }, parent_tool_use_id: null })];
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
    clientEntry({ id, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: turn.prompt ?? `Turn ${index + 1}.`, text_elements: [] }] } }),
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
  const stopId = ctx.nextId++;
  out.push(
    item('item/started', cmd),
    clientEntry({ id: stopId, method: 'turn/interrupt', params: { threadId, turnId } }, { params: { turnId } }),
    cliEntry({ id: stopId, result: {} }),
    item('item/completed', { ...cmd, status: 'failed', aggregatedOutput: '', durationMs: 1000 }),
    cliEntry({ method: 'turn/completed', params: { threadId, turn: turnObj('interrupted') } }),
  );
  return out;
}

// ── Copilot ACP ─────────────────────────────────────────────────────────────

function copilotTurn(turn: ScriptTurn, index: number, ctx: TurnContext): Entry[] {
  const sessionId = ctx.sessionId;
  const update = (u: Entry) => cliEntry({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
  const id = ctx.nextId++;
  const out: Entry[] = [clientEntry({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: turn.prompt ?? `Turn ${index + 1}.` }] } })];
  for (const step of turn.steps) {
    if (step.type === 'text') {
      out.push(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } }));
    } else if (step.type === 'image-tool') {
      const variant = step.variant ?? 'asset';
      const toolCallId = `call_script_${++ctx.seq}`;
      const img = imageBytes(step.image);
      let binary: Entry;
      if (variant === 'asset') {
        binary = { type: 'image', assetId: img.assetId, mimeType: step.image.mimeType, byteLength: img.byteLength };
        // Copilot journals the bytes just before the tool's result (copilot-assets.ts).
        ctx.synthesized.add('session.binary_asset journal line fields beyond type, assetId and data');
        ctx.journal.push({ type: 'session.binary_asset', data: { assetId: img.assetId, mimeType: step.image.mimeType, byteLength: img.byteLength, data: img.data } });
      } else if (variant === 'inline') {
        binary = { type: 'image', mimeType: step.image.mimeType, data: img.data };
      } else if (variant === 'omitted') {
        binary = { type: 'image', mimeType: step.image.mimeType, omittedReason: 'too_large' };
      } else {
        unsupported('copilot', `${variant} image`);
      }
      out.push(
        update({ sessionUpdate: 'tool_call', toolCallId, title: 'View image', kind: 'read', status: 'pending', rawInput: { path: step.image.path }, locations: [{ path: step.image.path }] }),
        update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { content: 'Viewed image', binaryResultsForLlm: [binary] } }),
      );
    } else if (step.type === 'command') {
      unsupported('copilot', 'command');
    } else if (step.type === 'approval') {
      // As copilot/permission-deny, with allow_once.
      const command = approvalCommand('copilot', step.approval);
      const requestId = ctx.cliRequestId++;
      const toolCallId = `call_script_${++ctx.seq}`;
      const rawInput = { command, ...(step.approval.description && { description: step.approval.description }) };
      const title = step.approval.title ?? `Run ${command}`;
      out.push(
        update({ sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute', status: 'pending', rawInput }),
        cliEntry({ jsonrpc: '2.0', id: requestId, method: 'session/request_permission', params: {
          sessionId,
          toolCall: { toolCallId, title, kind: 'execute', status: 'pending', rawInput },
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
          ],
        } }),
        clientEntry(
          { jsonrpc: '2.0', id: requestId, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } },
          { id: requestId, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } },
        ),
        update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { content: step.approval.result ?? 'Done.' } }),
      );
    } else {
      unsupported('copilot', 'question');
    }
  }
  const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };
  if ((turn.end ?? 'end_turn') === 'end_turn') {
    out.push(cliEntry({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage } }));
    return out;
  }
  // Held (as copilot/interrupt).
  const toolCallId = `call_script_${++ctx.seq}`;
  out.push(
    update({ sessionUpdate: 'tool_call', toolCallId, title: 'Run sleep 600', kind: 'execute', status: 'pending', rawInput: { command: 'sleep 600' } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' }),
    clientEntry({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: { content: 'The user cancelled the operation.' } }),
    cliEntry({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled', usage } }),
  );
  return out;
}
