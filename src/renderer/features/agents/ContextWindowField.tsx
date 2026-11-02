import type { ContextWindowOptions } from '../../../shared/context-window';
import { CONTEXT_WINDOW_NEXT_START, COPILOT_DEFAULT_TIER, COPILOT_LONG_CONTEXT, formatContextTokens, type ContextLimits } from '../../../shared/context-window';

/** The select's value for no saved choice. */
const NO_CHOICE = '';

/** The select for the saved next-start choice; disabled with the reason where the CLI offers none. */
export function ContextWindowSelect({ id, options, value, disabled, className, onChange }: {
  id?: string;
  options: ContextWindowOptions | null;
  value: string | undefined;
  disabled?: boolean;
  className: string;
  onChange: (value: string | null) => void;
}) {
  if (!options) return <span className="text-ctp-overlay1">Loading</span>;
  if (options.configurable === false) return <span className="text-ctp-overlay1" data-testid="context-window-unavailable">{options.reason}</span>;
  const known = !value || options.choices.some((c) => c.id === value);
  return (
    <select
      id={id}
      aria-label={options.label}
      className={className}
      value={value ?? NO_CHOICE}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === NO_CHOICE ? null : e.target.value)}
    >
      <option value={NO_CHOICE}>{options.defaultLabel}</option>
      {!known && <option value={value}>{value}</option>}
      {options.choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>
  );
}

/** What the choice does, what more costs and when it applies, as plain sentences. */
export function contextWindowHelp(options: ContextWindowOptions | null): string | undefined {
  if (!options || options.configurable === false) return undefined;
  return `${options.description} ${options.costNote} ${CONTEXT_WINDOW_NEXT_START}`;
}

/** A saved choice without its catalog (the catalog isn't read for an awake agent): "500K", "Long context". */
export function formatContextChoice(value: string): string {
  if (value === COPILOT_LONG_CONTEXT) return 'Long context';
  if (value === COPILOT_DEFAULT_TIER) return 'Standard';
  const tokens = Number(value);
  return tokens > 0 ? formatContextTokens(tokens) : value;
}

/** What a running session reports, kept apart from the saved choice: "300K, compacts at 267K, 33K in reserve". */
export function contextSummary(limits: ContextLimits | null | undefined, usageSize?: number): string | null {
  const size = limits?.effectiveTokens ?? usageSize;
  if (!size) return null;
  return [
    formatContextTokens(size),
    limits?.compactAtTokens ? `compacts at ${formatContextTokens(limits.compactAtTokens)}` : null,
    limits?.reservedTokens ? `${formatContextTokens(limits.reservedTokens)} in reserve` : null,
  ].filter(Boolean).join(', ');
}
