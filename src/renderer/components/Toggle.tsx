import type { ComponentProps } from 'react';

/**
 * The app's one switch (#2014): 28×16, `role="switch"` with `aria-checked`.
 * Give it an accessible name with `aria-label`, or `aria-labelledby` pointing
 * at the row's label.
 */
export function Toggle({ checked, onChange, disabled, className = '', ...rest }: Omit<ComponentProps<'button'>, 'onChange' | 'onClick' | 'role' | 'type' | 'aria-checked'> & {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      data-on={String(checked)}
      onClick={() => { if (!disabled) onChange(!checked); }}
      className={`relative flex-shrink-0 w-7 h-4 rounded-full transition-colors duration-150 ${
        checked ? 'bg-ctp-accent' : 'bg-surface-1'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full transition-transform duration-150 ${
          checked ? 'translate-x-3 bg-ctp-crust' : 'translate-x-0 bg-ctp-subtext0'
        }`}
      />
    </button>
  );
}
