import type { ComponentProps, ReactNode } from 'react';

/**
 * The app's button (#2014): 28px tall, radius 6, 12px text, in four kinds.
 * `primary` is the one main action in a view, `ghost` the bordered secondary,
 * `quiet` a borderless action, `danger` a destructive secondary. `danger-solid`
 * is only for the confirm button of a destructive dialog.
 *
 * An icon-only button (no children) is square and needs an `aria-label`.
 */

export type ButtonKind = 'primary' | 'ghost' | 'quiet' | 'danger' | 'danger-solid';

const KIND: Record<ButtonKind, string> = {
  primary: 'bg-ctp-accent border-ctp-accent text-ctp-crust enabled:hover:bg-ctp-accent/90',
  ghost: 'bg-transparent border-surface-1 text-ctp-subtext1 enabled:hover:bg-surface-0 enabled:hover:text-ctp-text',
  quiet: 'bg-transparent border-transparent text-ctp-subtext1 enabled:hover:bg-surface-0 enabled:hover:text-ctp-text',
  danger: 'bg-transparent border-surface-1 text-ctp-red enabled:hover:bg-surface-0',
  'danger-solid': 'bg-ctp-red border-ctp-red text-ctp-crust enabled:hover:bg-ctp-red/90',
};

export function Button({ kind = 'ghost', icon, className = '', type = 'button', children, ...rest }: ComponentProps<'button'> & {
  kind?: ButtonKind;
  /** A 14px icon drawn before the label. */
  icon?: ReactNode;
}) {
  const iconOnly = !!icon && (children === undefined || children === null || children === false);
  return (
    <button
      type={type}
      data-kind={kind}
      className={`inline-flex flex-shrink-0 items-center justify-center gap-1.5 h-7 ${iconOnly ? 'w-7 px-0' : 'px-2.5'} rounded-md border text-xs font-medium whitespace-nowrap transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${KIND[kind]} ${className}`}
      {...rest}
    >
      {icon && <span className="flex flex-shrink-0 items-center [&>svg]:w-3.5 [&>svg]:h-3.5" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}
