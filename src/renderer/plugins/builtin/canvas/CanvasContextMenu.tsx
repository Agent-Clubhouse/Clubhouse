import React, { useEffect, useState, useCallback } from 'react';
import type { CanvasViewType } from './canvas-types';
import {
  getRegisteredWidgetTypes,
  onRegistryChange,
  type RegisteredCanvasWidget,
} from '../../canvas-widget-registry';
import { usePluginStore } from '../../plugin-store';
import { PopupMenu, type MenuEntry } from '../../../components/PopupMenu';
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

/** An SVG string as a menu icon node. */
function svgIcon(svg: string) {
  return <span className="flex" dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />;
}

export function CanvasContextMenu({ x, y, onSelect, onDismiss }: CanvasContextMenuProps) {
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
  // The shared menu closes on an outside click or Esc; a canvas menu also
  // closes when the window loses focus, as before.
  useEffect(() => {
    window.addEventListener('blur', onDismiss);
    return () => window.removeEventListener('blur', onDismiss);
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

  const builtinItem = ({ type, label, icon }: { type: CanvasViewType; label: string; icon: string }): MenuEntry => ({
    id: type,
    label,
    icon: svgIcon(icon),
    onSelect: () => handleBuiltinSelect(type),
  });

  const items: MenuEntry[] = [
    builtinItem(AGENT_ITEM),
    ...visibleWidgets.map((widget): MenuEntry => ({
      id: widget.qualifiedType,
      label: sentenceCase(widget.declaration.label),
      icon: widget.declaration.icon ? svgIcon(widget.declaration.icon) : <span>+</span>,
      onSelect: () => handlePluginSelect(widget),
    })),
    { id: 'separator-layout', separator: true },
    ...LAYOUT_ITEMS.map(builtinItem),
  ];

  return (
    <PopupMenu
      items={items}
      position={{ x, y }}
      label="Add to canvas"
      testId="canvas-context-menu"
      minWidth={200}
      onClose={onDismiss}
    />
  );
}
