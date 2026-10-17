import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '../zIndex';
import { hasOpenModal, LAYER_PORTAL_ATTR } from './layers';
import { formatShortcut } from './Tooltip';

/**
 * The app's popup menu (#2014), promoted from the chrome sidebar's project
 * menu: mantle, border surface-1, radius 8, 28px rows, `role="menu"`. Arrow
 * keys, Home and End move between items (roving tabindex), Esc or a click
 * outside closes it, and focus returns to the trigger. Esc closes only the
 * menu, never a Modal under it.
 */

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Red text, for destructive actions. */
  danger?: boolean;
  /** A 14px icon before the label, drawn in overlay1. */
  icon?: ReactNode;
  /** Free-form content before the label (a status dot and avatar, say), drawn as given. */
  leading?: ReactNode;
  /** Free-form content on the right in overlay1 (a status word, a count), before the shortcut. */
  trailing?: ReactNode;
  /** The current item (the agent you're on, say): surface0 background, `aria-current`, and focus on open. */
  selected?: boolean;
  /** A binding string like "Meta+K", shown on the right. */
  shortcut?: string;
  onSelect: () => void;
}

export interface MenuSeparator { id: string; separator: true }

export type MenuEntry = MenuItem | MenuSeparator;

/**
 * The surface the menu opens over. `dropdown` is the app shell; `modal`,
 * `canvasDialog` and `top` put it just above those layers. Defaults to
 * `modal` while a Modal is open, otherwise `dropdown`.
 */
export type MenuLayer = 'dropdown' | 'modal' | 'canvasOverlay' | 'canvasDialog' | 'top';

const isSeparator = (e: MenuEntry): e is MenuSeparator => 'separator' in e;
const ITEMS = '[role="menuitem"]:not([aria-disabled="true"])';
const MARGIN = 8;

export function PopupMenu({ items, position, label, testId, minWidth = 180, layer, onClose }: {
  items: MenuEntry[];
  /** Viewport point the menu opens at; it's kept on screen. */
  position: { x: number; y: number };
  label: string;
  testId: string;
  minWidth?: number;
  layer?: MenuLayer;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const enabled = items.filter((i): i is MenuItem => !isSeparator(i) && !i.disabled);
  const [activeId, setActiveId] = useState<string | undefined>(() => (enabled.find((i) => i.selected) ?? enabled[0])?.id);
  const [autoLayer, setAutoLayer] = useState<MenuLayer>('dropdown');
  const l = layer ?? autoLayer;
  const zIndex = l === 'dropdown' ? Z_INDEX.dropdown : Z_INDEX[l] + 1;
  // A modal mounting in the same commit is in the DOM by now, though its effect hasn't run.
  useLayoutEffect(() => {
    if (hasOpenModal() || document.querySelector('[role="dialog"][aria-modal="true"]')) setAutoLayer('modal');
  }, []);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(`${ITEMS}[tabindex="0"]`)?.focus();
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current(); };
    // Capture phase, so this runs before a Modal's Esc handler, which skips handled events.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
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
    else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-testid={testId}
      {...{ [LAYER_PORTAL_ATTR]: '' }}
      onKeyDown={onKeyDown}
      style={{ left: pos?.left ?? position.x, top: pos?.top ?? position.y, minWidth, zIndex }}
      className="fixed p-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl"
    >
      {items.map((item) => isSeparator(item) ? (
        <div key={item.id} role="separator" className="h-px my-1 mx-1.5 bg-surface-0" />
      ) : (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={item.id === activeId ? 0 : -1}
          aria-current={item.selected ? 'true' : undefined}
          aria-disabled={item.disabled || undefined}
          data-testid={`${testId}-${item.id}`}
          onFocus={() => setActiveId(item.id)}
          onClick={() => { if (item.disabled) return; onClose(); item.onSelect(); }}
          className={`w-full h-7 flex items-center gap-2 px-2.5 rounded-md text-left text-xs outline-none ${
            item.disabled
              ? 'text-ctp-overlay0 cursor-default'
              : `${item.danger ? 'text-ctp-red' : item.selected ? 'text-ctp-text' : 'text-ctp-subtext1 hover:text-ctp-text focus-visible:text-ctp-text'} ${item.selected ? 'bg-surface-0' : ''} hover:bg-surface-0 focus-visible:bg-surface-0 cursor-pointer`
          }`}
        >
          {item.icon && <span className="flex flex-shrink-0 text-ctp-overlay1 [&>svg]:w-3.5 [&>svg]:h-3.5" aria-hidden="true">{item.icon}</span>}
          {item.leading && <span className="flex flex-shrink-0 items-center gap-1.5" aria-hidden="true">{item.leading}</span>}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.trailing && <span className="ml-4 flex flex-shrink-0 items-center gap-1.5 text-ctp-overlay1">{item.trailing}</span>}
          {item.shortcut && <kbd className="ml-4 flex-shrink-0 font-sans text-xs text-ctp-overlay1">{formatShortcut(item.shortcut)}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
