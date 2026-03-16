import React, { useEffect, useRef } from 'react';
import type { CanvasViewType } from './canvas-types';

interface CanvasContextMenuProps {
  x: number;
  y: number;
  onSelect: (type: CanvasViewType) => void;
  onDismiss: () => void;
}

const MENU_ITEMS: Array<{ type: CanvasViewType; label: string; icon: string }> = [
  { type: 'agent', label: 'Add Agent View', icon: '>' },
  { type: 'file', label: 'Add File View', icon: '#' },
  { type: 'browser', label: 'Add Browser View', icon: '@' },
];

export function CanvasContextMenu({ x, y, onSelect, onDismiss }: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onDismiss]);

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[180px] bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl py-1 backdrop-blur-none"
      style={{ left: x, top: y }}
      data-testid="canvas-context-menu"
    >
      {MENU_ITEMS.map(({ type, label, icon }) => (
        <button
          key={type}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-text hover:bg-ctp-surface1 transition-colors text-left"
          onClick={(e) => { e.stopPropagation(); onSelect(type); }}
          data-testid={`canvas-context-menu-${type}`}
        >
          <span className="w-4 text-center font-mono text-ctp-overlay0">{icon}</span>
          {label}
        </button>
      ))}
    </div>
  );
}
