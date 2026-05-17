/**
 * useCanvasContextMenu — canvas and view context menu state.
 *
 * Extracted from CanvasWorkspace to isolate menu state from viewport
 * and selection re-render cycles.
 */

import { useState, useCallback, useLayoutEffect, useRef } from 'react';
import type { CanvasViewType, Viewport } from './canvas-types';
import type { ContextMenuSelection } from './CanvasContextMenu';
import { screenToCanvas, clampMenuPosition } from './canvas-operations';
import { useDismissibleLayer } from './useDismissibleLayer';

export interface CanvasContextMenuState {
  x: number;
  y: number;
  canvasX: number;
  canvasY: number;
}

export interface ViewContextMenuState {
  x: number;
  y: number;
  viewId: string;
}

export interface CanvasContextMenuOptions {
  viewport: Viewport;
  containerRef: React.RefObject<HTMLDivElement | null>;
  layoutCenterId: string | null;
  onAddView: (type: CanvasViewType, position: { x: number; y: number }) => void;
  onAddPluginView: (pluginId: string, qualifiedType: string, label: string, position: { x: number; y: number }, defaultSize?: { width: number; height: number }) => void;
  onSetLayoutCenterId: (value: string | null) => void;
}

export interface CanvasContextMenuResult {
  contextMenu: CanvasContextMenuState | null;
  viewContextMenu: ViewContextMenuState | null;
  viewMenuRef: React.RefObject<HTMLDivElement>;
  handleContextMenu: (e: React.MouseEvent) => void;
  handleContextMenuAction: (selection: ContextMenuSelection) => void;
  handleDismissContextMenu: () => void;
  handleViewContextMenu: (viewId: string, e: React.MouseEvent) => void;
  handleSetLayoutCenter: (viewId: string) => void;
  handleDismissViewContextMenu: () => void;
  handleCenterViewFromMenu: (viewId: string, onCenterView: (id: string) => void) => void;
}

export function useCanvasContextMenu({
  viewport,
  containerRef,
  layoutCenterId,
  onAddView,
  onAddPluginView,
  onSetLayoutCenterId,
}: CanvasContextMenuOptions): CanvasContextMenuResult {
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [viewContextMenu, setViewContextMenu] = useState<ViewContextMenuState | null>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null!);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const canvasPos = screenToCanvas(e.clientX, e.clientY, rect, viewport);
    setContextMenu({ x: e.clientX, y: e.clientY, canvasX: canvasPos.x, canvasY: canvasPos.y });
  }, [viewport, containerRef]);

  const handleContextMenuAction = useCallback((selection: ContextMenuSelection) => {
    if (!contextMenu) { setContextMenu(null); return; }
    const pos = { x: contextMenu.canvasX, y: contextMenu.canvasY };
    if (selection.kind === 'builtin') {
      onAddView(selection.type, pos);
    } else {
      onAddPluginView(selection.pluginId, selection.qualifiedType, selection.label, pos, selection.defaultSize);
    }
    setContextMenu(null);
  }, [contextMenu, onAddView, onAddPluginView]);

  const handleDismissContextMenu = useCallback(() => {
    setContextMenu(null);
    setViewContextMenu(null);
  }, []);

  const handleViewContextMenu = useCallback((viewId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setViewContextMenu({ x: e.clientX, y: e.clientY, viewId });
  }, []);

  const handleSetLayoutCenter = useCallback((viewId: string) => {
    onSetLayoutCenterId(layoutCenterId === viewId ? null : viewId);
    setViewContextMenu(null);
  }, [layoutCenterId, onSetLayoutCenterId]);

  const handleDismissViewContextMenu = useCallback(() => {
    setViewContextMenu(null);
  }, []);

  const handleCenterViewFromMenu = useCallback((viewId: string, onCenterView: (id: string) => void) => {
    onCenterView(viewId);
    setViewContextMenu(null);
  }, []);

  useDismissibleLayer({
    layerRef: viewMenuRef,
    onDismiss: handleDismissViewContextMenu,
    enabled: !!viewContextMenu,
  });

  // Clamp view context menu to viewport bounds after the menu element is rendered and measured.
  // We update state (not the DOM directly) so React controls the final position consistently
  // across re-renders. Direct el.style mutations would be silently reset whenever React
  // reconciles the same JSX style prop from a parent re-render.
  useLayoutEffect(() => {
    const el = viewMenuRef.current;
    if (!el || !viewContextMenu) return;
    const rect = el.getBoundingClientRect();
    const clamped = clampMenuPosition(
      viewContextMenu.x, viewContextMenu.y,
      rect.width, rect.height,
      window.innerWidth, window.innerHeight,
    );
    if (clamped.x !== viewContextMenu.x || clamped.y !== viewContextMenu.y) {
      setViewContextMenu({ ...viewContextMenu, x: clamped.x, y: clamped.y });
    }
  }, [viewContextMenu]);

  return {
    contextMenu,
    viewContextMenu,
    viewMenuRef,
    handleContextMenu,
    handleContextMenuAction,
    handleDismissContextMenu,
    handleViewContextMenu,
    handleSetLayoutCenter,
    handleDismissViewContextMenu,
    handleCenterViewFromMenu,
  };
}
