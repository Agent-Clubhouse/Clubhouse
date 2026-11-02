/**
 * A per-agent context setting (#2660), as each CLI really offers it. These are
 * different things and are labelled as such: Claude Code's sets when it
 * compacts and leaves the model's own window alone, Codex's sets the window it
 * uses, and Copilot's picks a tier the model has. Choices are built per model
 * from what the CLI says; there is no free-form number.
 */

/** When a saved choice takes effect. None apply to a running session: no CLI changes this in place in a way we could verify. */
export type ContextWindowApplies = 'launch' | 'resume';

export type ContextWindowKind = 'working_window' | 'context_window' | 'tier';

export interface ContextWindowChoice {
  /** What agent.update and the durable config store. */
  id: string;
  label: string;
  /** The size this gives, when the CLI says. */
  tokens?: number;
}

export type ContextWindowOptions =
  | {
    configurable: false;
    /** `unsupported`: the CLI or model has no such setting. `pick_model`: it depends on the model. `unavailable`: the catalog couldn't be read. */
    state: 'unsupported' | 'pick_model' | 'unavailable';
    label: string;
    reason: string;
  }
  | {
    configurable: true;
    kind: ContextWindowKind;
    label: string;
    /** What this setting does, in the CLI's own terms. */
    description: string;
    /** The row meaning no saved value: the CLI decides. */
    defaultLabel: string;
    choices: ContextWindowChoice[];
    /** The size without a saved value, when the CLI says. Its own config can change it. */
    defaultTokens: number | null;
    maxTokens: number | null;
    /** What a larger choice costs, as far as it's known. */
    costNote: string;
    applies: ContextWindowApplies[];
  };

/** A running session's context as the CLI reports it. Null: it doesn't report that. */
export interface ContextLimits {
  /** The context the session works within. */
  effectiveTokens: number | null;
  /** Where it compacts. */
  compactAtTokens: number | null;
  /** Capacity kept free below `effectiveTokens`. */
  reservedTokens: number | null;
  /** What the figures mean, where they could be misread. */
  note?: string | null;
}

/** Claude's figure is the working window, not the model's own. */
export const CLAUDE_WORKING_WINDOW_NOTE = 'Claude Code\'s working context. The model\'s own window isn\'t changed.';
export const INPUT_WINDOW_NOTE = 'Counts input tokens. The output reserve is separate.';

export const CONTEXT_WINDOW_APPLIES: ContextWindowApplies[] = ['launch', 'resume'];
export const CONTEXT_WINDOW_NEXT_START = 'Applies the next time the agent starts. A running session keeps its size.';

export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Why a saved value can't stay, or null when it can. Unavailable or undecided catalogs say nothing against it. */
export function contextWindowRefusal(value: string, options: ContextWindowOptions): string | null {
  if (options.configurable === false) return options.state === 'unsupported' ? options.reason : null;
  return options.choices.some((c) => c.id === value) ? null : `${value} isn't one this model offers.`;
}

// ── Claude Code ─────────────────────────────────────────────────────────

const CLAUDE_WORKING_SIZES = [100_000, 200_000, 300_000, 500_000, 750_000, 1_000_000];

/**
 * The models whose standard window is under 1M, without `[1m]`. An estimate
 * for the choices only: the CLI caps a larger value itself (Haiku 4.5 with
 * 500k runs at 200K), and a session reports what it got.
 */
const CLAUDE_200K_MODEL = /(^|-)(haiku-4|haiku-3|opus-4(-[0-5])?($|-\d{8})|sonnet-4(-[0-5])?($|-\d{8})|claude-3)/;

export function claudeModelCeiling(model: string | undefined): number {
  if (model && /\[1m\]/i.test(model)) return 1_000_000;
  return model && CLAUDE_200K_MODEL.test(model) ? 200_000 : 1_000_000;
}

export function claudeContextWindowOptions(model: string | undefined): ContextWindowOptions {
  const ceiling = claudeModelCeiling(model);
  return {
    configurable: true,
    kind: 'working_window',
    label: 'Working context',
    description: 'How much conversation Claude Code keeps before it compacts. This doesn\'t change the model\'s own context window, and a lower value compacts sooner. It compacts a little below this size.',
    defaultLabel: 'Auto',
    choices: CLAUDE_WORKING_SIZES
      .filter((t) => t <= ceiling)
      .map((t) => ({ id: String(t), label: formatContextTokens(t), tokens: t })),
    defaultTokens: null,
    maxTokens: ceiling,
    costNote: 'A larger size sends more history with each message, so long sessions use more tokens. Your plan or the model can cap it; a running session shows what it got.',
    applies: CONTEXT_WINDOW_APPLIES,
  };
}

// ── Codex ───────────────────────────────────────────────────────────────

/** One model's context fields from `codex debug models`. */
export interface CodexContextEntry {
  slug: string;
  contextWindow: number;
  maxContextWindow: number;
  /** The share of the window Codex treats as usable (95 for 95%). */
  effectivePercent: number;
}

const CODEX_LABEL = 'Context window';
const CODEX_SIZES = [128_000, 200_000, 272_000, 400_000, 600_000, 872_000, 1_000_000];

export function codexContextWindowOptions(entry: CodexContextEntry | undefined): ContextWindowOptions {
  if (!entry) {
    return { configurable: false, state: 'unsupported', label: CODEX_LABEL, reason: 'Codex doesn\'t list a context size for this model.' };
  }
  const { contextWindow: size, maxContextWindow: max, effectivePercent: percent } = entry;
  if (max <= size) {
    return { configurable: false, state: 'unsupported', label: CODEX_LABEL, reason: `This model has one size, ${formatContextTokens(size)}.` };
  }
  const usable = (t: number) => Math.round((t * percent) / 100);
  const sizes = [...new Set([...CODEX_SIZES.filter((t) => t < max), max])].filter((t) => t !== size);
  return {
    configurable: true,
    kind: 'context_window',
    label: CODEX_LABEL,
    description: `The window Codex uses with this model. It treats ${percent}% of it as usable and compacts before it fills.`,
    defaultLabel: `Default (${formatContextTokens(size)})`,
    choices: sizes.map((t) => ({ id: String(t), label: `${formatContextTokens(t)} (${formatContextTokens(usable(t))} usable)`, tokens: usable(t) })),
    defaultTokens: usable(size),
    maxTokens: usable(max),
    costNote: 'A larger window sends more history with each message, so long sessions use more tokens.',
    applies: CONTEXT_WINDOW_APPLIES,
  };
}

/** Context fields from `codex debug models`, Codex's default model first; null when it isn't the expected shape. */
export function parseCodexContextCatalog(stdout: string): CodexContextEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const entries: CodexContextEntry[] = [];
  const rank = (m: Record<string, unknown>) => (typeof m?.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER);
  const listed = (models as Array<Record<string, unknown>>).filter((m) => m?.visibility !== 'hide').sort((a, b) => rank(a) - rank(b));
  const hidden = (models as Array<Record<string, unknown>>).filter((m) => m?.visibility === 'hide');
  for (const m of [...listed, ...hidden]) {
    if (typeof m?.slug !== 'string' || typeof m.context_window !== 'number') continue;
    entries.push({
      slug: m.slug,
      contextWindow: m.context_window,
      maxContextWindow: typeof m.max_context_window === 'number' ? m.max_context_window : m.context_window,
      effectivePercent: typeof m.effective_context_window_percent === 'number' ? m.effective_context_window_percent : 100,
    });
  }
  return entries;
}

// ── Copilot ─────────────────────────────────────────────────────────────

export const COPILOT_LONG_CONTEXT = 'long_context';
export const COPILOT_DEFAULT_TIER = 'default';

/** One model's tiers from the SDK's `models.list`. */
export interface CopilotTierEntry {
  id: string;
  hasLongContext: boolean;
  standardTokens: number | null;
  longTokens: number | null;
  standardInputPrice: number | null;
  longInputPrice: number | null;
}

const COPILOT_LABEL = 'Context tier';

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** A model from `client.listModels()`. Tiers are in `billing.tokenPrices`, or `supportedContextTiers` without pricing. */
export function copilotTierEntry(model: Record<string, unknown>): CopilotTierEntry | null {
  if (typeof model.id !== 'string') return null;
  const prices = (model.billing as { tokenPrices?: Record<string, unknown> } | undefined)?.tokenPrices;
  const long = prices?.longContext as Record<string, unknown> | undefined;
  const tiers = model.supportedContextTiers;
  return {
    id: model.id,
    hasLongContext: !!long || (Array.isArray(tiers) && tiers.includes(COPILOT_LONG_CONTEXT)),
    standardTokens: num(prices?.maxPromptTokens),
    longTokens: num(long?.maxPromptTokens),
    standardInputPrice: num(prices?.inputPrice),
    longInputPrice: num(long?.inputPrice),
  };
}

function copilotCostNote(entry: CopilotTierEntry): string {
  if (entry.standardInputPrice !== null && entry.longInputPrice !== null) {
    return `Long context uses ${entry.longInputPrice} AI credits per batch of input tokens, against ${entry.standardInputPrice} on the standard tier.`;
  }
  return 'Long context has its own pricing, and larger inputs use more credits.';
}

export function copilotContextWindowOptions(model: string | undefined, entries: CopilotTierEntry[] | null): ContextWindowOptions {
  if (!model || model === 'default' || model === 'auto') {
    return { configurable: false, state: 'pick_model', label: COPILOT_LABEL, reason: 'Tiers depend on the model. Choose a model to see them.' };
  }
  if (!entries) {
    return { configurable: false, state: 'unavailable', label: COPILOT_LABEL, reason: 'Couldn\'t read Copilot\'s model list. It needs a Copilot login.' };
  }
  const entry = entries.find((e) => e.id === model);
  if (!entry) {
    return { configurable: false, state: 'unavailable', label: COPILOT_LABEL, reason: 'Copilot\'s model list doesn\'t include this model.' };
  }
  if (!entry.hasLongContext) {
    return { configurable: false, state: 'unsupported', label: COPILOT_LABEL, reason: 'This model has no long context tier.' };
  }
  const named = (name: string, t: number | null) => (t ? `${name} (${formatContextTokens(t)} input)` : name);
  return {
    configurable: true,
    kind: 'tier',
    label: COPILOT_LABEL,
    description: 'Which of the model\'s context tiers the session uses. With no choice saved, Copilot uses its own setting, and a resumed session keeps the tier it last used.',
    defaultLabel: 'Copilot\'s setting',
    choices: [
      { id: COPILOT_DEFAULT_TIER, label: named('Standard', entry.standardTokens), ...(entry.standardTokens && { tokens: entry.standardTokens }) },
      { id: COPILOT_LONG_CONTEXT, label: named('Long context', entry.longTokens), ...(entry.longTokens && { tokens: entry.longTokens }) },
    ],
    defaultTokens: entry.standardTokens,
    maxTokens: entry.longTokens,
    costNote: copilotCostNote(entry),
    applies: CONTEXT_WINDOW_APPLIES,
  };
}
