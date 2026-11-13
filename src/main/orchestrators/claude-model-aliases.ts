/** Aliases Claude Code resolves itself, listed by `initialize` or not. */
const CLAUDE_MODEL_ALIASES = new Set(['default', 'best', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

export function isClaudeModelAlias(model: string): boolean {
  return CLAUDE_MODEL_ALIASES.has(model.replace(/\[1m\]$/i, '').toLowerCase());
}
