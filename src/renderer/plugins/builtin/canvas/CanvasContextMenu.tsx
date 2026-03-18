import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { CanvasViewType } from './canvas-types';
import {
  getRegisteredWidgetTypes,
  onRegistryChange,
  type RegisteredCanvasWidget,
} from '../../canvas-widget-registry';
import { MenuPortal } from './MenuPortal';

/** A menu item can either be a built-in view type or a qualified plugin widget type string. */
export type ContextMenuSelection =
  | { kind: 'builtin'; type: CanvasViewType }
  | { kind: 'plugin'; qualifiedType: string; pluginId: string; label: string; defaultSize?: { width: number; height: number } };

interface CanvasContextMenuProps {
  x: number;
  y: number;
  onSelect: (selection: ContextMenuSelection) => void;
  onDismiss: () => void;
}

const BUILTIN_ITEMS: Array<{ type: CanvasViewType; label: string; icon: string }> = [
  { type: 'agent', label: 'Add Agent View', icon: '>' },
  { type: 'file', label: 'Add File View', icon: '#' },
  { type: 'browser', label: 'Add Browser View', icon: '@' },
  { type: 'git-diff', label: 'Add Git Diff View', icon: '±' },
  { type: 'terminal', label: 'Add Terminal View', icon: '$' },
];

export function CanvasContextMenu({ x, y, onSelect, onDismiss }: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pluginWidgets, setPluginWidgets] = useState<RegisteredCanvasWidget[]>(() => getRegisteredWidgetTypes());

  useEffect(() => {
    const disposable = onRegistryChange(() => {
      setPluginWidgets(getRegisteredWidgetTypes());
    });
    return () => disposable.dispose();
  }, []);

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

  const handleBuiltinSelect = useCallback((type: CanvasViewType) => {
    onSelect({ kind: 'builtin', type });
  }, [onSelect]);

  const handlePluginSelect = useCallback((widget: RegisteredCanvasWidget) => {
    onSelect({
      kind: 'plugin',
      qualifiedType: widget.qualifiedType,
      pluginId: widget.pluginId,
      label: widget.declaration.label,
      defaultSize: widget.declaration.defaultSize,
    });
  }, [onSelect]);

  return (
    <MenuPortal>
      <div
        ref={menuRef}
        className="fixed z-[9999] min-w-[180px] bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl py-1 backdrop-blur-none"
        style={{ left: x, top: y }}
        data-testid="canvas-context-menu"
      >
        {BUILTIN_ITEMS.map(({ type, label, icon }) => (
          <button
            key={type}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-text hover:bg-ctp-surface1 transition-colors text-left"
            onClick={(e) => { e.stopPropagation(); handleBuiltinSelect(type); }}
            data-testid={`canvas-context-menu-${type}`}
          >
            <span className="w-4 text-center font-mono text-ctp-overlay0">{icon}</span>
            {label}
          </button>
        ))}
        {pluginWidgets.length > 0 && (
          <>
            <div className="border-t border-surface-0 my-1" />
            {pluginWidgets.map((widget) => (
              <button
                key={widget.qualifiedType}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-text hover:bg-ctp-surface1 transition-colors text-left"
                onClick={(e) => { e.stopPropagation(); handlePluginSelect(widget); }}
                data-testid={`canvas-context-menu-${widget.qualifiedType}`}
              >
                <span className="w-4 text-center font-mono text-ctp-overlay0">
                  {widget.declaration.icon || '+'}
                </span>
                Add {widget.declaration.label}
              </button>
            ))}
          </>
        )}
      </div>
    </MenuPortal>
  );
}
