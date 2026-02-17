import type { BadgeType } from '../stores/badgeStore';

interface BadgeProps {
  type: BadgeType;
  value: number;
  className?: string;
  /** Use a smaller variant for inline display (e.g. explorer tab labels). */
  inline?: boolean;
}

/**
 * Badge indicator component — renders as a red count pill or small dot.
 *
 * - **Count mode**: Red circle with white number, truncated to "99+" for large values.
 * - **Dot mode**: Small colored dot indicator (no number).
 * - Returns `null` when value is 0 or type is invalid.
 */
export function Badge({ type, value, className = '', inline = false }: BadgeProps) {
  if (value <= 0) return null;

  if (type === 'dot') {
    return (
      <span
        data-testid="badge-dot"
        className={`
          ${inline ? 'w-2 h-2' : 'w-2.5 h-2.5'}
          rounded-full bg-red-500 inline-block flex-shrink-0
          ${className}
        `}
      />
    );
  }

  if (type === 'count') {
    const display = value > 99 ? '99+' : String(value);
    return (
      <span
        data-testid="badge-count"
        className={`
          ${inline ? 'min-w-[16px] h-4 text-[9px] px-1' : 'min-w-[18px] h-[18px] text-[10px] px-1'}
          rounded-full bg-red-500 text-white font-bold
          inline-flex items-center justify-center flex-shrink-0 leading-none
          ${className}
        `}
      >
        {display}
      </span>
    );
  }

  return null;
}
