import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../chrome/sidebar/useClickOutside';
import { formatShortcut } from './Tooltip';

/**
 * The app's popup menu (#2014), promoted from the chrome sidebar's project
 * menu: mantle, border surface-1, radius 8, 28px rows, `role="menu"`. Arrow
 * keys, Home and End move between items, Esc or a click outside closes it,
 * and focus returns to the trigger.
 */

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Red text, for destructive actions. */
  danger?: boolean;
  /** A 14px icon before the label. */
  icon?: ReactNode;
  /** A binding string like "Meta+K", shown on the right. */
  shortcut?: string;
  onSelect: () => void;
}

export interface MenuSeparator { id: string; separator: true }

export type MenuEntry = MenuItem | MenuSeparator;

const isSeparator = (e: MenuEntry): e is MenuSeparator => 'separator' in e;
const ITEMS = '[role="menuitem"]:not([aria-disabled="true"])';
const MARGIN = 8;

export function PopupMenu({ items, position, label, testId, minWidth = 180, onClose }: {
  items: MenuEntry[];
  /** Viewport point the menu opens at; it's kept on screen. */
  position: { x: number; y: number };
  label: string;
  testId: string;
  minWidth?: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useClickOutside(ref, true, close);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    return () => {
      // Only pull focus back when it was still in the menu (a selection or Esc), not after a click elsewhere.
      if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body)) previous.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(MARGIN, Math.min(position.x, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(position.y, window.innerHeight - height - MARGIN)),
    });
  }, [position.x, position.y, items.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => { e.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at < 0 ? all.length - 1 : at - 1);
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
      style={{ left: pos?.left ?? position.x, top: pos?.top ?? position.y, minWidth }}
      className="fixed z-dropdown p-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl"
    >
      {items.map((item) => isSeparator(item) ? (
        <div key={item.id} role="separator" className="h-px my-1 mx-1.5 bg-surface-0" />
      ) : (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-disabled={item.disabled || undefined}
          data-testid={`${testId}-${item.id}`}
          onClick={() => { if (item.disabled) return; onClose(); item.onSelect(); }}
          className={`w-full h-7 flex items-center gap-2 px-2.5 rounded-md text-left text-[12.5px] outline-none ${
            item.disabled
              ? 'text-ctp-overlay0 cursor-default'
              : `${item.danger ? 'text-ctp-red' : 'text-ctp-subtext1 hover:text-ctp-text focus-visible:text-ctp-text'} hover:bg-surface-0 focus-visible:bg-surface-0 cursor-pointer`
          }`}
        >
          {item.icon && <span className="flex flex-shrink-0 text-ctp-overlay1 [&>svg]:w-3.5 [&>svg]:h-3.5" aria-hidden="true">{item.icon}</span>}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.shortcut && <kbd className="ml-4 flex-shrink-0 font-sans text-[11px] text-ctp-overlay1">{formatShortcut(item.shortcut)}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
