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

// SVG icons for built-in items — 18×18 Lucide-style to match plugin widget icons
const AGENT_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const BROWSER_VIEW_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const GIT_DIFF_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;
const ANCHOR_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>`;

/** First-class built-in view types. File and Terminal are now provided by their
 *  respective plugins via the widget API; legacy versions remain available
 *  at the bottom of the menu for backward compatibility. */
const BUILTIN_ITEMS: Array<{ type: CanvasViewType; label: string; icon: string }> = [
  { type: 'agent', label: 'Add Agent View', icon: AGENT_ICON },
  { type: 'browser', label: 'Add Browser View', icon: BROWSER_VIEW_ICON },
  { type: 'git-diff', label: 'Add Git Diff View', icon: GIT_DIFF_ICON },
  { type: 'anchor', label: 'Add Anchor', icon: ANCHOR_ICON },
];

/** Qualified types for the plugin-provided file and terminal widgets.
 *  These are shown in the context menu with the main built-in items. */
const PROMOTED_PLUGIN_TYPES = new Set([
  'plugin:files:file-viewer',
  'plugin:terminal:shell',
]);

/** Deprecated built-in view types that use the legacy rendering path. */
const LEGACY_ITEMS: Array<{ type: CanvasViewType; label: string; icon: string }> = [
  { type: 'legacy-file', label: 'Add File View (Legacy)', icon: '#' },
  { type: 'legacy-terminal', label: 'Add Terminal View (Legacy)', icon: '$' },
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

  // Separate promoted plugin widgets (file-viewer, terminal) from other 3p widgets
  const promotedWidgets = pluginWidgets.filter((w) => PROMOTED_PLUGIN_TYPES.has(w.qualifiedType));
  const otherWidgets = pluginWidgets.filter((w) => !PROMOTED_PLUGIN_TYPES.has(w.qualifiedType));

  return (
    <MenuPortal>
      <div
        ref={menuRef}
        className="fixed z-[9999] min-w-[180px] bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl py-1 backdrop-blur-none"
        style={{ left: x, top: y }}
        data-testid="canvas-context-menu"
      >
        {/* Built-in views + promoted plugin widgets (File Viewer, Terminal) */}
        {BUILTIN_ITEMS.map(({ type, label, icon }) => (
          <button
            key={type}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-text hover:bg-ctp-surface1 transition-colors text-left"
            onClick={(e) => { e.stopPropagation(); handleBuiltinSelect(type); }}
            data-testid={`canvas-context-menu-${type}`}
          >
            <span className="w-4 text-center text-ctp-overlay0" dangerouslySetInnerHTML={{ __html: icon }} />
            {label}
          </button>
        ))}
        {promotedWidgets.map((widget) => (
          <button
            key={widget.qualifiedType}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-text hover:bg-ctp-surface1 transition-colors text-left"
            onClick={(e) => { e.stopPropagation(); handlePluginSelect(widget); }}
            data-testid={`canvas-context-menu-${widget.qualifiedType}`}
          >
            <span className="w-4 text-center text-ctp-overlay0">
              {widget.declaration.icon
                ? <span dangerouslySetInnerHTML={{ __html: widget.declaration.icon }} />
                : '+'}
            </span>
            Add {widget.declaration.label}
          </button>
        ))}

        {/* Other 3rd-party plugin widgets */}
        {otherWidgets.length > 0 && (
          <>
            <div className="border-t border-surface-0 my-1" />
            {otherWidgets.map((widget) => (
              <button
                key={widget.qualifiedType}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-text hover:bg-ctp-surface1 transition-colors text-left"
                onClick={(e) => { e.stopPropagation(); handlePluginSelect(widget); }}
                data-testid={`canvas-context-menu-${widget.qualifiedType}`}
              >
                <span className="w-4 text-center text-ctp-overlay0">
                  {widget.declaration.icon
                    ? <span dangerouslySetInnerHTML={{ __html: widget.declaration.icon }} />
                    : '+'}
                </span>
                Add {widget.declaration.label}
              </button>
            ))}
          </>
        )}

        {/* Legacy view types — deprecated, for backward compatibility */}
        <div className="border-t border-surface-0 my-1" />
        {LEGACY_ITEMS.map(({ type, label, icon }) => (
          <button
            key={type}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ctp-overlay0 hover:bg-ctp-surface1 transition-colors text-left"
            onClick={(e) => { e.stopPropagation(); handleBuiltinSelect(type); }}
            data-testid={`canvas-context-menu-${type}`}
          >
            <span className="w-4 text-center font-mono text-ctp-overlay0">{icon}</span>
            {label}
          </button>
        ))}
      </div>
    </MenuPortal>
  );
}
