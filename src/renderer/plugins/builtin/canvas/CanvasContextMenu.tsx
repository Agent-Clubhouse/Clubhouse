import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { CanvasViewType } from './canvas-types';
import {
  getRegisteredWidgetTypes,
  onRegistryChange,
  type RegisteredCanvasWidget,
} from '../../canvas-widget-registry';
import { usePluginStore } from '../../plugin-store';
import { MenuPortal } from './MenuPortal';
import { useDismissibleLayer } from './useDismissibleLayer';
import { sanitizeSvg } from '../../../utils/sanitize-svg';
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';
import { AGENT_ICON, ANCHOR_ICON, ZONE_ICON } from './canvas-icons';

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

/**
 * Sentence-case a widget label: "Git Diff" becomes "Git diff". Words with a
 * capital past the first letter (GitHub, PRs) are names and stay as they are.
 */
export function sentenceCase(label: string): string {
  return label
    .split(' ')
    .map((word, i) => (i === 0 || /[A-Z]/.test(word.slice(1)) ? word : word.toLowerCase()))
    .join(' ');
}

/** Built-in view types that are not provided by plugins. Agent leads; anchor and zone follow the widgets. */
const AGENT_ITEM = { type: 'agent' as CanvasViewType, label: 'Agent', icon: AGENT_ICON };
const LAYOUT_ITEMS: Array<{ type: CanvasViewType; label: string; icon: string }> = [
  { type: 'anchor', label: 'Anchor', icon: ANCHOR_ICON },
  { type: 'zone', label: 'Zone', icon: ZONE_ICON },
];

const ROW = 'w-full h-7 flex items-center gap-2 px-3 text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text transition-colors text-left';
const ICON = 'w-4 flex-shrink-0 flex items-center justify-center text-ctp-overlay1 [&_svg]:w-3.5 [&_svg]:h-3.5';

export function CanvasContextMenu({ x, y, onSelect, onDismiss }: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const mcpEnabled = !!useMcpSettingsStore((s) => s.enabled);
  const plugins = usePluginStore((s) => s.plugins);
  const appEnabled = usePluginStore((s) => s.appEnabled);
  const [pluginWidgets, setPluginWidgets] = useState<RegisteredCanvasWidget[]>(() => getRegisteredWidgetTypes());

  useEffect(() => {
    const disposable = onRegistryChange(() => {
      setPluginWidgets(getRegisteredWidgetTypes());
    });
    return () => disposable.dispose();
  }, []);

  const appEnabledSet = new Set(appEnabled);
  const visibleWidgets = pluginWidgets.filter((w) => {
    if (!appEnabledSet.has(w.pluginId)) return false;
    const manifest = plugins[w.pluginId]?.manifest;
    if (manifest?.requiresMcp && !mcpEnabled) return false;
    return true;
  });
  useDismissibleLayer({ layerRef: menuRef, onDismiss });

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

  const builtinRow = ({ type, label, icon }: { type: CanvasViewType; label: string; icon: string }) => (
    <button
      key={type}
      type="button"
      role="menuitem"
      className={ROW}
      onClick={(e) => { e.stopPropagation(); handleBuiltinSelect(type); }}
      data-testid={`canvas-context-menu-${type}`}
    >
      <span className={ICON} dangerouslySetInnerHTML={{ __html: sanitizeSvg(icon) }} />
      {label}
    </button>
  );

  return (
    <MenuPortal>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Add to canvas"
        className="fixed z-canvas-overlay min-w-[200px] bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl py-1"
        style={{ left: x, top: y }}
        data-testid="canvas-context-menu"
      >
        {builtinRow(AGENT_ITEM)}

        {/* Plugin-provided widgets */}
        {visibleWidgets.map((widget) => (
          <button
            key={widget.qualifiedType}
            type="button"
            role="menuitem"
            className={ROW}
            onClick={(e) => { e.stopPropagation(); handlePluginSelect(widget); }}
            data-testid={`canvas-context-menu-${widget.qualifiedType}`}
          >
            <span className={ICON}>
              {widget.declaration.icon
                ? <span className="flex" dangerouslySetInnerHTML={{ __html: sanitizeSvg(widget.declaration.icon) }} />
                : '+'}
            </span>
            {sentenceCase(widget.declaration.label)}
          </button>
        ))}

        <div className="border-t border-surface-0 my-1" role="separator" />
        {LAYOUT_ITEMS.map(builtinRow)}
      </div>
    </MenuPortal>
  );
}
