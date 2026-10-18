/**
 * Pure derivations from a ChatViewState into what ChatView renders. Kept out
 * of the components so the grouping rules are testable on fixture streams.
 *
 * Every downgrade here reads ChatCapabilities, never the provider or driver
 * id (docs/structured-chat-research.md §7, "Capabilities, not provider checks").
 */

import { PERMISSION_LEVEL_LABELS } from '../../../../shared/chat';
import type { ChatCapabilities, PermissionLevel, ToolCallContent } from '../../../../shared/chat';
import type { ChatItem, ChatViewState, PendingPermission, PlanDocumentItem, SubagentInfo, ToolCallItem, TurnEndItem } from '../../../stores/chatStore';

// ── Stream blocks ───────────────────────────────────────────────────────────

export interface ItemBlock {
  type: 'item';
  key: string;
  item: ChatItem;
  /** The hidden tool call a question row or plan card stands for, so its error still shows. */
  tool?: ToolCallItem;
}
/** A run of consecutive read-only tool calls, shown as one "Explored" row. */
export interface ExploreBlock { type: 'explore'; key: string; tools: ToolCallItem[] }
/** A subagent with its own work folded underneath. */
export interface SubagentBlock { type: 'subagent'; key: string; info: SubagentInfo; tool?: ToolCallItem; children: ChatItem[] }
export type StreamBlock = ItemBlock | ExploreBlock | SubagentBlock;

const READ_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think']);

/** A tool call that only looks around: no diff or output, didn't fail. */
export function isExploreTool(item: ChatItem): item is ToolCallItem {
  if (item.kind !== 'tool_call') return false;
  if (!READ_ONLY_KINDS.has(item.toolKind)) return false;
  if (item.status === 'failed' || item.status === 'pending') return false;
  return !item.content.some((c) => c.type === 'diff' || c.type === 'terminal');
}

/**
 * Turn the flat item list into render blocks.
 *
 * - With `subagents: 'full'`, items tagged with a known subagent move under
 *   that subagent's card, which replaces its parent tool call. With 'ids_only'
 *   or 'none' they stay in the main stream as ordinary rows.
 * - Two or more consecutive read-only tools fold into an ExploreBlock.
 */
export function buildStreamBlocks(state: Pick<ChatViewState, 'items' | 'subagents' | 'capabilities'>): StreamBlock[] {
  const { items, subagents } = state;
  const nestSubagents = state.capabilities?.subagents === 'full';

  const childrenOf = new Map<string, ChatItem[]>();
  const byParentTool = new Map<string, SubagentInfo>();
  if (nestSubagents) {
    for (const info of Object.values(subagents)) {
      childrenOf.set(info.subagentId, []);
      if (info.parentToolCallId) byParentTool.set(info.parentToolCallId, info);
    }
  }

  const top: Array<ChatItem | SubagentBlock> = [];
  const placed = new Set<string>();
  const placeSubagent = (info: SubagentInfo, tool?: ToolCallItem) => {
    placed.add(info.subagentId);
    top.push({ type: 'subagent', key: `sub:${info.subagentId}`, info, ...(tool && { tool }), children: childrenOf.get(info.subagentId) ?? [] });
  };

  // A question row or plan card already stands for its tool call (Claude's
  // AskUserQuestion, ExitPlanMode); don't show the call's raw input as well.
  const shownElsewhere = new Set<string>();
  for (const item of items) {
    if ((item.kind === 'question' || item.kind === 'plan_document') && item.toolCallId) shownElsewhere.add(item.toolCallId);
  }
  // ...but its outcome (a denial message, an error) shows on the row that stands for it.
  const standIns = new Map<string, ToolCallItem>();

  for (const item of items) {
    if (item.kind === 'tool_call' && shownElsewhere.has(item.toolCallId)) {
      standIns.set(item.toolCallId, item);
      continue;
    }
    const subId = 'subagentId' in item ? item.subagentId : undefined;
    if (nestSubagents && subId && childrenOf.has(subId)) {
      childrenOf.get(subId)!.push(item);
      // A subagent without a parent tool call appears where its work starts.
      if (!placed.has(subId)) placeSubagent(subagents[subId]);
      continue;
    }
    if (nestSubagents && item.kind === 'tool_call' && byParentTool.has(item.toolCallId)) {
      const info = byParentTool.get(item.toolCallId)!;
      if (!placed.has(info.subagentId)) placeSubagent(info, item);
      continue;
    }
    top.push(item);
  }

  const blocks: StreamBlock[] = [];
  let run: ToolCallItem[] = [];
  const flush = () => {
    if (run.length >= 2) blocks.push({ type: 'explore', key: `explore:${run[0].id}`, tools: run });
    else for (const t of run) blocks.push({ type: 'item', key: t.id, item: t });
    run = [];
  };
  for (const entry of top) {
    if ('type' in entry && entry.type === 'subagent') {
      flush();
      blocks.push(entry);
      continue;
    }
    const item = entry as ChatItem;
    if (isExploreTool(item)) {
      run.push(item);
      continue;
    }
    flush();
    const tool = (item.kind === 'question' || item.kind === 'plan_document') && item.toolCallId ? standIns.get(item.toolCallId) : undefined;
    blocks.push(tool ? { type: 'item', key: item.id, item, tool } : { type: 'item', key: item.id, item });
  }
  flush();
  return blocks;
}

/** "Explored 3 files, 2 searches". */
export function exploreLabel(tools: ToolCallItem[], running: boolean): string {
  let files = 0;
  let searches = 0;
  let other = 0;
  for (const t of tools) {
    if (t.toolKind === 'read') files++;
    else if (t.toolKind === 'search') searches++;
    else other++;
  }
  const parts: string[] = [];
  if (files) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`);
  if (searches) parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`);
  if (other) parts.push(`${other} ${other === 1 ? 'lookup' : 'lookups'}`);
  return `${running ? 'Exploring' : 'Explored'} ${parts.join(', ')}`;
}

/** The target to show next to a tool's verb: first location, else the title. */
export function toolTarget(tool: ToolCallItem): string {
  return tool.locations?.[0]?.path ?? tool.title;
}

/**
 * Tool cards in the transcript start collapsed to one row (#2110). Failed calls
 * start open so the error and output are in view, and so do calls waiting for
 * approval, so you can see what you're approving. Running calls stay collapsed:
 * their live output is what floods the transcript. A row the user toggled keeps
 * the user's choice; otherwise it follows the status, so a running call that
 * fails opens itself.
 */
export function toolOpenByDefault(status: ToolCallItem['status']): boolean {
  return status === 'failed' || status === 'pending';
}

/**
 * Server and tool of an MCP call, from the `mcp__<server>__<tool>` name every
 * driver reports. Tool names can contain `__` (Clubhouse's own
 * `group__<project>__post_bulletin`), so the longest known server name wins,
 * and without one the name splits at the first `__` after the prefix.
 */
export function mcpTool(tool: ToolCallItem, servers?: ReadonlyArray<{ name: string }> | null): { server: string; tool: string } | null {
  const name = tool.toolName ?? '';
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const known = (servers ?? [])
    .map((s) => s.name)
    .filter((n) => n && rest.startsWith(`${n}__`) && rest.length > n.length + 2)
    .sort((a, b) => b.length - a.length)[0];
  if (known) return { server: known, tool: rest.slice(known.length + 2) };
  const m = /^(.+?)__(.+)$/.exec(rest);
  return m ? { server: m[1], tool: m[2] } : null;
}

/** The tool's input as an object with at least one key, else null. */
export function toolArgs(tool: ToolCallItem): Record<string, unknown> | null {
  const input = tool.rawInput;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return Object.keys(input).length > 0 ? input as Record<string, unknown> : null;
}

/** A one-line hint for a collapsed tool row: the first short string argument. */
export function argSummary(tool: ToolCallItem): string {
  const first = Object.values(toolArgs(tool) ?? {}).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return first ? first.replace(/\s+/g, ' ').trim() : '';
}

/** Claude wraps tool-level failures in `<tool_use_error>` tags (#2184); show the message alone. */
export function stripToolUseError(text: string): string {
  return text.replace(/<\/?tool_use_error>/g, '');
}

/** What a finished tool returned: its text content, else its raw output. */
export function toolResultText(tool: ToolCallItem): string {
  const text = tool.content
    .filter((c): c is Extract<ToolCallContent, { type: 'text' }> => c.type === 'text')
    .map((c) => stripToolUseError(c.text))
    .join('\n');
  if (text) return text;
  if (tool.rawOutput === undefined || tool.rawOutput === null) return '';
  return typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2);
}

/**
 * The tool's error for display, unless `shown` (what the card already shows)
 * is that same message: drivers often send a failure's message as both the
 * result and the error (#2182). Only the same text, whitespace aside, counts:
 * a result that merely mentions the error's words doesn't hide it.
 */
export function toolErrorText(tool: ToolCallItem, shown = ''): string | undefined {
  if (!tool.error) return undefined;
  const error = stripToolUseError(tool.error);
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const message = squash(error);
  if (!message) return undefined;
  return squash(stripToolUseError(shown)) === message ? undefined : error;
}

export function diffContent(tool: ToolCallItem): Array<Extract<ToolCallContent, { type: 'diff' }>> {
  return tool.content.filter((c): c is Extract<ToolCallContent, { type: 'diff' }> => c.type === 'diff');
}

/** Terminal output, joined across appended chunks. */
export function terminalContent(tool: ToolCallItem): { command?: string; output: string; exitCode?: number } | null {
  const chunks = tool.content.filter((c): c is Extract<ToolCallContent, { type: 'terminal' }> => c.type === 'terminal');
  if (chunks.length === 0) return null;
  const last = chunks[chunks.length - 1];
  const command = chunks.find((c) => c.command)?.command;
  return {
    ...(command !== undefined && { command }),
    output: chunks.map((c) => c.output).join(''),
    ...(last.exitCode !== undefined && { exitCode: last.exitCode }),
  };
}

/** The command a tool ran, from its terminal content or its raw input. */
export function commandOf(tool: ToolCallItem): string {
  const term = terminalContent(tool);
  if (term?.command) return term.command;
  const input = tool.rawInput as { command?: unknown } | undefined;
  if (input && typeof input.command === 'string') return input.command;
  return tool.title;
}

// ── Diffs ───────────────────────────────────────────────────────────────────

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export function parseUnifiedDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      out.push({ type: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      out.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      out.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith(' ')) {
      out.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

/** A text's lines. A final newline ends the last line rather than starting an empty one. */
function textLines(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line diff of old/new text (LCS). Fine for the edit sizes a single tool call makes. */
export function diffTexts(oldText: string | undefined, newText: string | undefined, startLine = 1): DiffLine[] {
  const a = textLines(oldText);
  const b = textLines(newText);
  if (a.length * b.length > 4_000_000) {
    // Too large to diff in the renderer: show it as a replace.
    return [
      ...a.map((text, i) => ({ type: 'del' as const, text, oldNo: startLine + i })),
      ...b.map((text, i) => ({ type: 'add' as const, text, newNo: startLine + i })),
    ];
  }
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i], oldNo: startLine + i, newNo: startLine + j }); i++; j++;
    } else if (i < a.length && (j >= b.length || dp[i + 1][j] >= dp[i][j + 1])) {
      // Removals before additions, as in a unified diff.
      out.push({ type: 'del', text: a[i], oldNo: startLine + i }); i++;
    } else {
      out.push({ type: 'add', text: b[j], newNo: startLine + j }); j++;
    }
  }
  return out;
}

export function diffLines(diff: Extract<ToolCallContent, { type: 'diff' }>, startLine?: number): DiffLine[] {
  if (diff.unifiedDiff) return parseUnifiedDiff(diff.unifiedDiff);
  return diffTexts(diff.oldText, diff.newText, startLine);
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

// ── Composer and dock ───────────────────────────────────────────────────────

export type SendAction = 'send' | 'steer' | 'stop_and_send' | 'queue';

export interface ComposerModes {
  /** What Enter does. */
  primary: SendAction;
  /** What Shift+Enter does, or null when there's no second action. */
  secondary: SendAction | null;
  /** Stop (Esc) cancels the running turn. */
  canStop: boolean;
}

/**
 * Idle: Enter sends. Running: Enter steers when the driver can, otherwise
 * "Stop and send" when it can interrupt, otherwise it queues. Shift+Enter
 * queues when any queue exists.
 */
export function composerModes(caps: ChatCapabilities | null, running: boolean): ComposerModes {
  if (!running) return { primary: 'send', secondary: null, canStop: false };
  const canQueue = !!caps && caps.queue !== 'none';
  const canStop = !!caps?.interrupt;
  if (caps?.steer) return { primary: 'steer', secondary: canQueue ? 'queue' : null, canStop };
  if (canStop) return { primary: 'stop_and_send', secondary: canQueue ? 'queue' : null, canStop };
  return { primary: 'queue', secondary: null, canStop };
}

export const LEVEL_LABELS: Readonly<Record<PermissionLevel, string>> = PERMISSION_LEVEL_LABELS;

export const LEVEL_DESCRIPTIONS: Record<PermissionLevel, string> = {
  plan: 'Reads and plans, changes nothing',
  ask: 'Asks before edits and commands',
  auto_edit: 'Edits files, asks before commands',
  auto: 'Decides what needs approval',
  full_access: 'No prompts',
};

export function isRunningState(state: ChatViewState['state']): boolean {
  return state === 'running' || state === 'waiting_permission' || state === 'waiting_input';
}

/**
 * The session is over: it slept or stopped, or it failed with a fatal error.
 * A turn that ended in error leaves the session alive, so it isn't "ended".
 */
export function isSessionEnded(state: ChatViewState): boolean {
  if (state.state === 'sleeping') return true;
  if (state.state !== 'error') return false;
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.kind === 'error') return it.fatal;
    if (it.kind === 'turn_end' || it.kind === 'user_message') return false;
  }
  return false;
}

/**
 * The file changes a permission request would allow: the diff content of its
 * tool call, whichever driver supplied it (Claude from the tool input, ACP
 * from the tool_call content). Empty when there's nothing to preview.
 */
export function diffsForRequest(items: ChatItem[], req: PendingPermission): Array<Extract<ToolCallContent, { type: 'diff' }>> {
  if (!req.toolCallId) return [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'tool_call' && it.toolCallId === req.toolCallId) return diffContent(it);
  }
  return [];
}

/** A command from a tool input: a string, or an argv array (Codex). */
function inputCommand(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const cmd = (input as { command?: unknown }).command;
  if (typeof cmd === 'string' && cmd.trim()) return cmd;
  if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === 'string')) return cmd.join(' ');
  return undefined;
}

/**
 * The command a permission request would run, so the card never asks to
 * approve one blind: from the request's input (Claude's Bash), else from its
 * execute tool call (Codex, ACP). Undefined when the request's own content
 * already shows it, or when it isn't a command.
 */
export function commandForRequest(items: ChatItem[], req: PendingPermission): string | undefined {
  if (req.content?.some((c) => c.type === 'text' || c.type === 'terminal')) return undefined;
  const fromInput = inputCommand(req.rawInput);
  if (fromInput) return fromInput;
  if (!req.toolCallId) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'tool_call' || it.toolCallId !== req.toolCallId) continue;
    if (it.toolKind !== 'execute' && !it.content.some((c) => c.type === 'terminal')) return undefined;
    return terminalContent(it)?.command || inputCommand(it.rawInput);
  }
  return undefined;
}

/** The plan document a permission request approves, if it's a plan approval. */
export function planForRequest(items: ChatItem[], req: PendingPermission): PlanDocumentItem | undefined {
  if (!req.toolCallId) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'plan_document' && it.toolCallId === req.toolCallId) return it;
  }
  return undefined;
}

/**
 * Without structured plan approval, a session in Plan with a plan ready and no
 * turn running gets Clubhouse's own "switch level and implement" action.
 */
export function needsManualPlanHandoff(state: ChatViewState): boolean {
  if (state.capabilities?.planApproval) return false;
  if (state.level !== 'plan' || isRunningState(state.state)) return false;
  const hasPlan = state.plan.length > 0 || state.items.some((i) => i.kind === 'plan_document' && i.status === 'ready');
  return hasPlan;
}

/** Level to continue in after a manual plan hand-off: the first non-plan level the driver can switch to live. */
export function implementLevel(caps: ChatCapabilities | null): PermissionLevel | null {
  const live = caps?.liveLevels ?? [];
  for (const level of ['auto_edit', 'ask', 'auto'] as const) {
    if (live.includes(level)) return level;
  }
  return null;
}

// ── Command output ──────────────────────────────────────────────────────────

/** The command a message starts with, when it's one the session offers. */
export function slashCommandOf(text: string, commands: ReadonlyArray<{ name: string }>): string | null {
  const m = /^\/([\w:.-]+)(?:\s|$)/.exec(text.trimStart());
  return m && commands.some((c) => c.name === m[1]) ? m[1] : null;
}

/**
 * Text laid out in lines and space-aligned columns, like a CLI's own command
 * output, which markdown would join into one paragraph (#2179).
 */
export function looksPreformatted(text: string): boolean {
  if (text.includes('```')) return false;
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2 || lines.some((l) => /^\s*(\||#{1,6} )/.test(l))) return false;
  return lines.some((l) => /\S {2,}\S/.test(l));
}

/**
 * Ids of agent messages that are a slash command's own laid-out output: only
 * the first reply after the command, in the same turn and with no tool call
 * in between. Anything later is the agent talking, which stays markdown.
 */
export function commandOutputIds(items: ChatItem[], commands: ReadonlyArray<{ name: string }>): Set<string> {
  const ids = new Set<string>();
  let afterCommand = false;
  for (const item of items) {
    if (item.kind === 'user_message') {
      afterCommand = slashCommandOf(item.text, commands) !== null;
      continue;
    }
    if (!afterCommand || ('subagentId' in item && item.subagentId)) continue;
    if (item.kind === 'agent_message') {
      if (looksPreformatted(item.text)) ids.add(item.id);
      afterCommand = false;
    } else if (item.kind !== 'thought') {
      // A tool call, turn end, divider, notice...: the command's reply is over.
      afterCommand = false;
    }
  }
  return ids;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Clock-style elapsed time for the header, e.g. "0:42". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatCost(usd: number, estimate?: boolean): string {
  const v = usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
  return estimate ? `≈ ${v} at API rates` : v;
}

// ── Agent map ───────────────────────────────────────────────────────────────

export type AgentMapStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface AgentMapNode {
  subagentId: string;
  label: string;
  description?: string;
  status: AgentMapStatus;
  /** The subagent's own messages, thoughts and tool calls, in order. */
  items: ChatItem[];
  toolCount: number;
  tokens?: number;
  /** ts of the parent tool call, or of the subagent's first item. */
  startTs: number;
  /** Known once it has finished: the parent tool's duration, or first to last item. */
  durationMs?: number;
  /** The newest tool call's title, for a one-line "what it's doing". */
  activity?: string;
}

export interface AgentMap {
  /** 'full': named subagents with status; 'ids_only': work grouped by id, no names or status. */
  mode: 'full' | 'ids_only' | 'none';
  nodes: AgentMapNode[];
}

function lastTool(items: ChatItem[]): ToolCallItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'tool_call') return it;
  }
  return undefined;
}

/**
 * The subagents of this agent, for the agent map. Gated on
 * `capabilities.subagents`: 'full' uses the driver's subagent events, and
 * 'ids_only' groups items by their subagentId with generic labels.
 *
 * A subagent can't outlive its agent's turn. When the agent isn't working
 * any more, one still marked running is settled: cancelled if the last turn
 * was stopped or failed, otherwise its status is unknown (the driver never
 * said it finished).
 */
export function buildAgentMap(state: Pick<ChatViewState, 'items' | 'subagents' | 'capabilities' | 'state'>): AgentMap {
  const mode = state.capabilities?.subagents ?? 'none';
  if (mode === 'none') return { mode, nodes: [] };

  const itemsBy = new Map<string, ChatItem[]>();
  const order: string[] = [];
  const toolsById = new Map<string, ToolCallItem>();
  /** Where each subagent first shows up: its parent tool call or its first item. */
  const firstSeqBy = new Map<string, number>();
  const subByParent = new Map<string, string>();
  if (mode === 'full') {
    for (const info of Object.values(state.subagents)) {
      if (info.parentToolCallId) subByParent.set(info.parentToolCallId, info.subagentId);
    }
  }
  let lastStop: TurnEndItem['stopReason'] | undefined;
  for (const item of state.items) {
    if (item.kind === 'turn_end') lastStop = item.stopReason;
    if (item.kind === 'tool_call') {
      toolsById.set(item.toolCallId, item);
      const owner = subByParent.get(item.toolCallId);
      if (owner && !firstSeqBy.has(owner)) firstSeqBy.set(owner, item.seq);
    }
    const subId = 'subagentId' in item ? item.subagentId : undefined;
    if (!subId) continue;
    if (!firstSeqBy.has(subId)) firstSeqBy.set(subId, item.seq);
    if (!itemsBy.has(subId)) { itemsBy.set(subId, []); order.push(subId); }
    itemsBy.get(subId)!.push(item);
  }
  const rootWorking = isRunningState(state.state);
  const settled: AgentMapStatus = lastStop === 'cancelled' || lastStop === 'error' || lastStop === 'timeout' ? 'cancelled' : 'unknown';

  const nodeFor = (subagentId: string, index: number): AgentMapNode => {
    const items = itemsBy.get(subagentId) ?? [];
    const info = mode === 'full' ? state.subagents[subagentId] : undefined;
    const parent = info?.parentToolCallId ? toolsById.get(info.parentToolCallId) : undefined;
    const ownTools = items.filter((i) => i.kind === 'tool_call');
    const toolRunning = ownTools.some((t) => t.kind === 'tool_call' && (t.status === 'in_progress' || t.status === 'pending'));
    let status: AgentMapStatus = info ? info.status : toolRunning ? 'running' : 'unknown';
    if (status === 'running' && !rootWorking) status = settled;
    const startTs = parent?.ts ?? items[0]?.ts ?? 0;
    const lastTs = items.length > 0 ? items[items.length - 1].ts : startTs;
    const tokens = info?.usage ? (info.usage.total ?? ((info.usage.input ?? 0) + (info.usage.output ?? 0))) : undefined;
    const node: AgentMapNode = {
      subagentId,
      label: info?.name ?? `Subagent ${index + 1}`,
      status,
      items,
      toolCount: info?.toolCount ?? ownTools.length,
      startTs,
    };
    const description = info?.description ?? parent?.title;
    if (description) node.description = description;
    if (tokens) node.tokens = tokens;
    if (status !== 'running' && status !== 'unknown') {
      node.durationMs = parent?.durationMs ?? Math.max(0, lastTs - startTs);
    }
    const activity = lastTool(items);
    if (activity) node.activity = activity.title;
    return node;
  };

  // Full mode lists every reported subagent, in the order it appeared; ids
  // the driver tagged items with but never described still get a node.
  const seqOf = (id: string) => firstSeqBy.get(id) ?? Number.MAX_SAFE_INTEGER;
  const ids = mode === 'full'
    ? [...Object.keys(state.subagents).sort((a, b) => seqOf(a) - seqOf(b)), ...order.filter((id) => !state.subagents[id])]
    : order;
  return { mode, nodes: ids.map(nodeFor) };
}

// ── Model labels ────────────────────────────────────────────────────────────

const ONE_M = /\[1m\]$/i;
const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i;

/**
 * The name to show for a model id, the same in the header and the composer.
 * The provider's own label wins; an id it doesn't list (a full Claude id such
 * as `claude-opus-5-5[1m]`, or an alias with the 1M context suffix) is named
 * the way the provider names its aliases, and anything else shows as-is.
 */
export function modelLabel(id: string, models: ReadonlyArray<{ id: string; label: string }> = []): string {
  const listed = models.find((m) => m.id === id);
  if (listed) return listed.label;
  const oneM = ONE_M.test(id);
  const base = id.replace(ONE_M, '');
  const suffix = oneM ? ' · 1M' : '';
  const alias = models.find((m) => m.id === base);
  if (alias) return `${alias.label}${suffix}`;
  const claude = CLAUDE_ID.exec(base);
  if (claude) {
    const [, family, major, minor] = claude;
    return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}${suffix}`;
  }
  return id;
}
