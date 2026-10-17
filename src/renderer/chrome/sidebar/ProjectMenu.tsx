import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from './useClickOutside';

/**
 * The project header's menu (docs/chrome-redesign-spec.md §4.8): Move up and
 * Move down are the keyboard equivalents of dragging, beside pin, collapse,
 * New agent and the project's settings.
 */

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export function PopupMenu({ items, position, label, testId, onClose }: {
  items: MenuItem[];
  position: { x: number; y: number };
  label: string;
  testId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useClickOutside(ref, true, close);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus(); }, []);

  const style = useMemo(() => ({
    left: Math.min(position.x, window.innerWidth - 188),
    top: Math.min(position.y, window.innerHeight - items.length * 30 - 16),
  }), [position, items.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => { e.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(all.length - 1);
    else if (e.key === 'Tab') onClose();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-testid={testId}
      onKeyDown={onKeyDown}
      style={style}
      className="fixed z-dropdown min-w-[180px] py-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-disabled={item.disabled || undefined}
          data-testid={`${testId}-${item.id}`}
          onClick={() => { if (item.disabled) return; onClose(); item.onSelect(); }}
          className={`w-full px-3 py-1.5 text-left text-xs ${
            item.disabled ? 'text-ctp-overlay0 cursor-default' : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
