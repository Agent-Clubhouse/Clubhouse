/**
 * The rewrite step (#3043): an agent's message to the Dispatcher becomes one
 * or two plain sentences in that agent's voice before it shows in the chat.
 * The chat never writes it: a separate one-off prompt does, on Auto's minimum
 * level for the Dispatcher's provider (#3044). A provider without an Auto
 * mapping (`auto_not_supported`), or a run that fails, falls back to the
 * Dispatcher's own short version, which tell_user always carries.
 *
 * The agent's raw message stays where it was written: in its own transcript.
 */
import { resolveProviderMinimum, type AutoLevelResolution } from '../helper-routing';
import { runHeadlessPrompt, type HeadlessPromptRequest, type HeadlessPromptResult } from '../headless-prompt';
import { cleanAgentNews, toInterjection } from '../../../shared/dispatcher-chat-noise';
import rewritePrompt from './dispatcher-rewrite-prompt.md';

/** The rewrite step's instructions, with `{agent}` and `{message}` to fill in. */
export const REWRITE_PROMPT: string = rewritePrompt;

/** The longest raw message sent to the rewrite: enough for any report worth two sentences. */
export const REWRITE_INPUT_MAX = 4_000;

export interface RewriteRequest {
  /** The Dispatcher's provider. */
  provider: string;
  /** The agent's name, as the chat shows it. */
  agentName: string;
  /** What the agent sent, as it sent it. Absent when there is none to rewrite. */
  raw?: string;
  /** The Dispatcher's own one or two sentences, used when the rewrite can't run. */
  fallback: string;
}

export interface RewriteResult {
  text: string;
  /** Who wrote it: the rewrite step, or the Dispatcher's own version. */
  by: 'rewrite' | 'fallback';
  /** Why the fallback was used. */
  reason?: 'no_raw' | 'auto_not_supported' | 'no_valid_mapping' | 'run_failed' | 'empty';
}

export interface RewriteDeps {
  resolveMinimum?: (provider: string) => Promise<AutoLevelResolution>;
  run?: (req: HeadlessPromptRequest) => Promise<HeadlessPromptResult>;
}

/** One line: the prompt may reach a CLI through a shell shim, which ends a command at a line break. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The rewrite step's prompt: Clubhouse's text (dispatcher-rewrite-prompt.md), which ships and updates
 * with the app, with the agent's name and its message filled in. Replaced in one pass, so a message
 * that contains a placeholder is never expanded.
 */
export function buildRewritePrompt(agentName: string, raw: string): string {
  const message = oneLine(raw).slice(0, REWRITE_INPUT_MAX);
  const values: Record<string, string> = { agent: oneLine(agentName), message };
  return oneLine(REWRITE_PROMPT.replace(/\{(agent|message)\}/g, (_, key: string) => values[key]));
}

function fallback(req: RewriteRequest, reason: RewriteResult['reason']): RewriteResult {
  return { text: toInterjection(req.fallback), by: 'fallback', reason };
}

/** The agent's message as the chat shows it. Never throws. */
export async function rewriteAgentNews(req: RewriteRequest, deps: RewriteDeps = {}): Promise<RewriteResult> {
  // Tool noise never needs rewriting: what is left is what the model reads.
  const raw = req.raw ? cleanAgentNews(req.raw) : '';
  if (!raw) return fallback(req, 'no_raw');
  let level: AutoLevelResolution;
  try {
    level = await (deps.resolveMinimum ?? resolveProviderMinimum)(req.provider);
  } catch {
    // telemetry-exempt: the Dispatcher's own version is shown instead; the caller logs which was used
    return fallback(req, 'no_valid_mapping');
  }
  if ('code' in level) return fallback(req, level.code);
  const result = await (deps.run ?? runHeadlessPrompt)({
    provider: level.provider,
    model: level.model,
    effort: level.effort,
    prompt: buildRewritePrompt(req.agentName, raw),
  }).catch((err: unknown): HeadlessPromptResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  if (!result.ok) return fallback(req, 'run_failed');
  const text = toInterjection(result.text);
  return text ? { text, by: 'rewrite' } : fallback(req, 'empty');
}
