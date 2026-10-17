/**
 * Pure summarizer for headless agent transcripts.
 *
 * Headless runs persist one stream-json event per line (Claude Code's
 * `--verbose --output-format stream-json`, or another provider's output after
 * normalization, see `codex-headless-events.ts`). The renderer reads the
 * transcript back when a run exits and when it renders a live run, so this
 * module has no Node or Electron imports.
 */

export interface HeadlessTranscriptSummary {
  /** The `result` event's text, else the last assistant text truncated to 500 chars. */
  summary: string | null;
  /** Files the run wrote, de-duplicated in first-seen order. */
  filesModified: string[];
  /** `total_cost_usd` ?? `cost_usd` from the last `result` event that carries one. */
  costUsd?: number;
  /** `duration_ms` from the last `result` event that carries one. */
  durationMs?: number;
  /** Distinct tool names, in first-seen order. */
  toolsUsed: string[];
  /** Number of tool calls (tool_use blocks, de-duplicated by id). */
  toolCalls: number;
  /** Input tokens, including cache reads and cache writes. */
  inputTokens: number;
  outputTokens: number;
}

type Rec = Record<string, unknown>;

const SUMMARY_FALLBACK_MAX = 500;

/** Tools whose input names the one file they write. */
const FILE_PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const NOTEBOOK_TOOLS = new Set(['NotebookEdit']);
/** Codex's patch tool, as normalized by codex-headless-events.ts (PATCH_TOOL). */
const PATCH_TOOLS = new Set(['apply_patch']);
/** Codex's shell tool: a command may be an `apply_patch` heredoc. */
const SHELL_TOOLS = new Set(['shell']);

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Content blocks of an assistant or user message event. */
function contentBlocks(event: Rec): Rec[] {
  const message = event.message;
  if (!isRec(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRec);
}

/**
 * Paths named in an apply_patch body, in order:
 * `*** Add File: p`, `*** Update File: p`, `*** Delete File: p`, `*** Move to: p`.
 */
export function parseApplyPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const raw of patch.split(/\r?\n/)) {
    const match = PATCH_HEADER.exec(raw.trim());
    if (match) {
      const p = match[1].trim();
      if (p) paths.push(p);
    }
  }
  return paths;
}

/** Collect strings from a tool input value that might hold patch text. */
function patchTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Files named by one tool_use block's input. */
function filesForToolUse(name: string, input: Rec): string[] {
  if (FILE_PATH_TOOLS.has(name)) {
    return typeof input.file_path === 'string' && input.file_path ? [input.file_path] : [];
  }

  if (NOTEBOOK_TOOLS.has(name)) {
    return typeof input.notebook_path === 'string' && input.notebook_path ? [input.notebook_path] : [];
  }

  if (PATCH_TOOLS.has(name)) {
    const files: string[] = [];
    // Patch body, under whichever key the provider used.
    for (const key of ['patch', 'input', 'command', 'content']) {
      for (const text of patchTexts(input[key])) files.push(...parseApplyPatchPaths(text));
    }
    // Codex file_change items: a list of { path, kind } changes.
    if (Array.isArray(input.changes)) {
      for (const change of input.changes) {
        if (isRec(change) && typeof change.path === 'string' && change.path) files.push(change.path);
        else if (typeof change === 'string' && change) files.push(change);
      }
    }
    if (Array.isArray(input.paths)) {
      for (const p of input.paths) if (typeof p === 'string' && p) files.push(p);
    }
    if (typeof input.path === 'string' && input.path) files.push(input.path);
    return files;
  }

  if (SHELL_TOOLS.has(name)) {
    // `apply_patch <<'EOF' *** Begin Patch ...` run through the shell.
    const texts = patchTexts(input.command);
    if (texts.some((t) => t.includes('*** Begin Patch'))) {
      return texts.flatMap(parseApplyPatchPaths);
    }
  }

  return [];
}

/**
 * Files written by tool calls in a transcript, de-duplicated in first-seen
 * order: Write / Edit / MultiEdit `file_path`, NotebookEdit `notebook_path`,
 * and the paths in Codex apply_patch calls. Legacy streaming events
 * (`content_block_*`) carry no tool input and are ignored.
 */
export function extractModifiedFiles(events: unknown[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const event of events) {
    if (!isRec(event) || event.type !== 'assistant') continue;
    for (const block of contentBlocks(event)) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      const input = isRec(block.input) ? block.input : {};
      for (const file of filesForToolUse(block.name, input)) {
        if (!seen.has(file)) {
          seen.add(file);
          files.push(file);
        }
      }
    }
  }
  return files;
}

interface Usage { input: number; output: number }

function readUsage(usage: unknown): Usage | null {
  if (!isRec(usage)) return null;
  return {
    input: num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
    output: num(usage.output_tokens),
  };
}

/**
 * Summarize a headless transcript: summary text, files written, cost, duration,
 * tools, tool call count and token usage.
 *
 * Token usage:
 * - Claude Code emits one `assistant` event per content block, each repeating
 *   the whole message's `usage`, so usage is counted once per `message.id`
 *   (the last report wins).
 * - Codex reports usage per turn on `turn.completed`, which the normalizer
 *   turns into a `result` event carrying `message.usage`; those are summed.
 * - Claude Code's own `result` event carries a session total at the top-level
 *   `usage`. It is used only when no per-message usage was seen, so it never
 *   double counts.
 */
export function summarizeHeadlessTranscript(events: unknown[]): HeadlessTranscriptSummary {
  let summary: string | null = null;
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  let lastAssistantText = '';
  const toolsUsed: string[] = [];
  const toolNames = new Set<string>();
  const toolIds = new Set<string>();
  let anonymousToolCalls = 0;

  const usageByMessage = new Map<string, Usage>();
  let anonymousUsage: Usage = { input: 0, output: 0 };
  let resultMessageUsage: Usage = { input: 0, output: 0 };
  let sawMessageUsage = false;
  let resultTotalUsage: Usage | null = null;

  const addTool = (name: string) => {
    if (!toolNames.has(name)) {
      toolNames.add(name);
      toolsUsed.push(name);
    }
  };

  for (const event of events) {
    if (!isRec(event)) continue;

    if (event.type === 'result') {
      if (typeof event.result === 'string' && event.result) summary = event.result;
      if (event.total_cost_usd != null) costUsd = num(event.total_cost_usd);
      else if (event.cost_usd != null) costUsd = num(event.cost_usd);
      if (event.duration_ms != null) durationMs = num(event.duration_ms);

      const message = event.message;
      const usage = isRec(message) ? readUsage(message.usage) : null;
      if (usage) {
        sawMessageUsage = true;
        resultMessageUsage = {
          input: resultMessageUsage.input + usage.input,
          output: resultMessageUsage.output + usage.output,
        };
      }
      const total = readUsage(event.usage);
      if (total) resultTotalUsage = total;
    }

    if (event.type === 'assistant') {
      const message = event.message;
      if (isRec(message)) {
        const usage = readUsage(message.usage);
        if (usage) {
          sawMessageUsage = true;
          if (typeof message.id === 'string' && message.id) {
            usageByMessage.set(message.id, usage);
          } else {
            anonymousUsage = { input: anonymousUsage.input + usage.input, output: anonymousUsage.output + usage.output };
          }
        }
      }

      for (const block of contentBlocks(event)) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          lastAssistantText = block.text;
        }
        if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
          addTool(block.name);
          // Codex can report a tool_use on both item.started and
          // item.completed under the same id; count the call once.
          if (typeof block.id === 'string' && block.id) toolIds.add(block.id);
          else anonymousToolCalls++;
        }
      }
    }

    // Legacy streaming format fallback (no --verbose)
    if (event.type === 'content_block_start' && isRec(event.content_block)) {
      const block = event.content_block;
      if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) addTool(block.name);
    }
    if (event.type === 'content_block_delta' && isRec(event.delta)) {
      const delta = event.delta;
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        lastAssistantText += delta.text;
      }
    }
    if (event.type === 'message_start') {
      lastAssistantText = '';
    }
  }

  if (!summary && lastAssistantText.trim()) {
    const text = lastAssistantText.trim();
    summary = text.length > SUMMARY_FALLBACK_MAX ? text.slice(0, SUMMARY_FALLBACK_MAX - 3) + '...' : text;
  }

  let inputTokens = anonymousUsage.input + resultMessageUsage.input;
  let outputTokens = anonymousUsage.output + resultMessageUsage.output;
  for (const usage of usageByMessage.values()) {
    inputTokens += usage.input;
    outputTokens += usage.output;
  }
  if (!sawMessageUsage && resultTotalUsage) {
    inputTokens = resultTotalUsage.input;
    outputTokens = resultTotalUsage.output;
  }

  const result: HeadlessTranscriptSummary = {
    summary,
    filesModified: extractModifiedFiles(events),
    toolsUsed,
    toolCalls: toolIds.size + anonymousToolCalls,
    inputTokens,
    outputTokens,
  };
  if (costUsd !== undefined) result.costUsd = costUsd;
  if (durationMs !== undefined) result.durationMs = durationMs;
  return result;
}
