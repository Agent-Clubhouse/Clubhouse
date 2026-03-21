import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType, AnchorCanvasView as AnchorCanvasViewType, PluginCanvasView as PluginCanvasViewType, Position, Size } from './canvas-types';
import { InlineRename } from './InlineRename';
import { MIN_VIEW_WIDTH, MIN_VIEW_HEIGHT, ANCHOR_HEIGHT } from './canvas-types';
import type { ProjectInfo } from '../../../../shared/plugin-types';
import { AgentCanvasView } from './AgentCanvasView';
import type { PluginAPI, CanvasWidgetMetadata } from '../../../../shared/plugin-types';
import type { CanvasViewAttention } from './canvas-types';
import { getRegisteredWidgetType, isWidgetPending, onRegistryChange } from '../../canvas-widget-registry';
import { LinkDropdown } from './LinkDropdown';

// ── Helpers ─────────────────────────────────────────────────────────

/** Sentence-case a view type string: 'git-diff' → 'Git diff' */
export function formatViewType(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/-/g, ' ');
}

/** Build a project context label for the title bar, e.g. "(Clubhouse)". */
export function buildProjectContext(view: CanvasView, projects: ProjectInfo[]): string | null {
  const projectId = ('projectId' in view) ? (view as AgentCanvasViewType).projectId : undefined;
  if (!projectId) return null;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  return project.name;
}

// ── Resize direction types ──────────────────────────────────────────

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const CURSOR_MAP: Record<ResizeDirection, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

/** Size of edge resize zones in pixels */
const EDGE_SIZE = 6;
/** Size of corner resize zones in pixels */
const CORNER_SIZE = 12;

interface ResizeState {
  size: Size;
  position: Position;
  direction: ResizeDirection;
}

interface CanvasViewComponentProps {
  view: CanvasView;
  api: PluginAPI;
  zoom: number;
  isZoomed?: boolean;
  isSelected?: boolean;
  isMultiSelected?: boolean;
  /** When true, hide this view because it's part of a multi-drag (non-primary). */
  multiDragHidden?: boolean;
  attention?: CanvasViewAttention | null;
  /** All views on the canvas (needed for LinkDropdown target list). */
  allViews?: CanvasView[];
  /** Whether MCP is enabled — controls visibility of Link/Wire buttons. */
  mcpEnabled?: boolean;
  /** Callback to start wire drag from this agent view. */
  onStartWireDrag?: (view: AgentCanvasViewType) => void;
  onClose: () => void;
  onFocus: () => void;
  onSelect: () => void;
  onToggleSelect: () => void;
  onCenterView: () => void;
  onZoomView: () => void;
  onDragStart: (viewId: string, mouseX: number, mouseY: number) => void;
  onDragMove?: (viewId: string, position: Position) => void;
  onDragEnd: (position: Position) => void;
  onResizeEnd: (size: Size, position: Position) => void;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

export function CanvasViewComponent({
  view,
  api,
  zoom,
  isZoomed,
  isSelected,
  isMultiSelected,
  multiDragHidden,
  attention,
  allViews,
  mcpEnabled,
  onStartWireDrag,
  onClose,
  onFocus,
  onSelect,
  onToggleSelect,
  onCenterView,
  onZoomView,
  onDragStart: onMultiDragStart,
  onDragMove,
  onDragEnd,
  onResizeEnd,
  onUpdate,
}: CanvasViewComponentProps) {
  const [dragPos, setDragPos] = useState<Position | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [anchorHovered, setAnchorHovered] = useState(false);
  const [linkDropdownOpen, setLinkDropdownOpen] = useState(false);

  // Subscribe to canvas widget registry changes so plugin views re-render
  // when their providing plugin activates (e.g. after project switch).
  const [, setRegistryTick] = useState(0);
  useEffect(() => {
    if (view.type !== 'plugin') return;
    const disposable = onRegistryChange(() => setRegistryTick((n) => n + 1));
    return () => disposable.dispose();
  }, [view.type]);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });
  const resizeStartRef = useRef({ mouseX: 0, mouseY: 0, startW: 0, startH: 0, startX: 0, startY: 0, direction: 'se' as ResizeDirection });

  // Refs for stable drag handler closures — avoids effect re-registration on
  // every render which could create a window where the mouseup handler is missing.
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const onDragMoveRef = useRef(onDragMove);
  onDragMoveRef.current = onDragMove;
  const dragPosRef = useRef<Position | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const currentPos = resizeState?.position ?? dragPos ?? view.position;
  const currentSize = resizeState?.size ?? view.size;

  // ── Permission state (agent views only) ─────────────────────────

  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    if (view.type !== 'agent') return;
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api, view.type]);

  // Agent info for identity chip
  const agentInfo = useMemo(() => {
    if (view.type !== 'agent') return null;
    const agentId = (view as AgentCanvasViewType).agentId;
    if (!agentId) return null;
    return api.agents.list().find((a) => a.id === agentId) ?? null;
  }, [api, view, agentTick]);

  // Project context for title bar
  const projectContext = useMemo(() => {
    const projects = api.projects.list();
    return buildProjectContext(view, projects);
  }, [api, view]);

  const isAgentRunning = agentInfo != null && (agentInfo.status === 'running' || agentInfo.status === 'creating');

  const handleSleep = useCallback(async () => {
    if (view.type !== 'agent') return;
    const agentId = (view as AgentCanvasViewType).agentId;
    if (agentId) await api.agents.kill(agentId);
  }, [view, api]);

  // ── Attention CSS class — uses outline so the glow goes OUTSIDE the card ──

  const attentionClass = attention
    ? attention.level === 'error'
      ? 'canvas-attention-error'
      : 'canvas-attention-warning'
    : '';

  // ── Drag ───────────────────────────────────────────────────────

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: view.position.x,
      startY: view.position.y,
    };
    dragPosRef.current = view.position;
    setDragPos(view.position);
    // Notify parent for multi-drag coordination
    onMultiDragStart(view.id, e.clientX, e.clientY);
  }, [view.position, onFocus, onMultiDragStart, view.id]);

  // Use `isDragging` boolean so the effect only registers/unregisters when
  // drag starts or ends — not on every mouse move or parent re-render.
  // Handlers read current values from refs to avoid stale closures.
  const isDragging = dragPos !== null;

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragStartRef.current.mouseX) / zoomRef.current;
      const dy = (e.clientY - dragStartRef.current.mouseY) / zoomRef.current;
      const newPos = {
        x: dragStartRef.current.startX + dx,
        y: dragStartRef.current.startY + dy,
      };
      dragPosRef.current = newPos;
      setDragPos(newPos);
      onDragMoveRef.current?.(view.id, newPos);
    };

    const handleMouseUp = () => {
      const pos = dragPosRef.current;
      if (pos) {
        onDragEndRef.current(pos);
      }
      dragPosRef.current = null;
      setDragPos(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // ── Resize (multi-directional) ─────────────────────────────────

  const handleResizeStart = useCallback((direction: ResizeDirection, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startW: view.size.width,
      startH: view.size.height,
      startX: view.position.x,
      startY: view.position.y,
      direction,
    };
    setResizeState({ size: view.size, position: view.position, direction });
  }, [view.size, view.position, onFocus]);

  useEffect(() => {
    if (resizeState === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      const ref = resizeStartRef.current;
      const dx = (e.clientX - ref.mouseX) / zoom;
      const dy = (e.clientY - ref.mouseY) / zoom;
      const dir = ref.direction;

      let newW = ref.startW;
      let newH = ref.startH;
      let newX = ref.startX;
      let newY = ref.startY;

      // East component: width increases with dx
      if (dir === 'e' || dir === 'se' || dir === 'ne') {
        newW = ref.startW + dx;
      }
      // West component: width decreases with dx, position moves
      if (dir === 'w' || dir === 'sw' || dir === 'nw') {
        newW = ref.startW - dx;
        newX = ref.startX + dx;
      }
      // South component: height increases with dy
      if (dir === 's' || dir === 'se' || dir === 'sw') {
        newH = ref.startH + dy;
      }
      // North component: height decreases with dy, position moves
      if (dir === 'n' || dir === 'ne' || dir === 'nw') {
        newH = ref.startH - dy;
        newY = ref.startY + dy;
      }

      // Anchors have a fixed height — only horizontal resize allowed
      if (view.type === 'anchor') {
        newH = ANCHOR_HEIGHT;
        newY = ref.startY;
      }

      // Enforce minimum size — clamp position if needed
      if (newW < MIN_VIEW_WIDTH) {
        if (dir === 'w' || dir === 'sw' || dir === 'nw') {
          newX = ref.startX + ref.startW - MIN_VIEW_WIDTH;
        }
        newW = MIN_VIEW_WIDTH;
      }
      if (view.type !== 'anchor' && newH < MIN_VIEW_HEIGHT) {
        if (dir === 'n' || dir === 'ne' || dir === 'nw') {
          newY = ref.startY + ref.startH - MIN_VIEW_HEIGHT;
        }
        newH = MIN_VIEW_HEIGHT;
      }

      setResizeState({
        size: { width: newW, height: newH },
        position: { x: newX, y: newY },
        direction: dir,
      });
    };

    const handleMouseUp = () => {
      if (resizeState) {
        onResizeEnd(resizeState.size, resizeState.position);
      }
      setResizeState(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizeState, zoom, onResizeEnd]);

  // ── Content based on view type ─────────────────────────────────

  const handleUpdateMetadata = useCallback((updates: CanvasWidgetMetadata) => {
    onUpdate({ metadata: { ...view.metadata, ...updates } });
  }, [view.metadata, onUpdate]);

  const renderContent = () => {
    switch (view.type) {
      case 'agent':
        return <AgentCanvasView view={view} api={api} onUpdate={onUpdate} />;
      case 'plugin': {
        const pluginView = view as PluginCanvasViewType;
        const registered = getRegisteredWidgetType(pluginView.pluginWidgetType);
        if (!registered) {
          return (
            <div className="flex items-center justify-center h-full text-ctp-overlay0 text-xs p-4 text-center">
              Widget type &quot;{pluginView.pluginWidgetType}&quot; is not available.
              The providing plugin may be disabled or uninstalled.
            </div>
          );
        }
        if (isWidgetPending(pluginView.pluginWidgetType)) {
          return (
            <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs p-4 text-center" data-testid="widget-loading">
              Loading {registered.declaration.label}…
            </div>
          );
        }
        const Component = registered.descriptor.component;
        return (
          <Component
            widgetId={view.id}
            api={api}
            metadata={view.metadata}
            onUpdateMetadata={handleUpdateMetadata}
            size={currentSize}
          />
        );
      }
    }
  };

  const { AgentAvatar } = api.widgets;

  // ── Selection highlight ─────────────────────────────────────────
  const selectionShadow = isSelected
    ? '0 4px 24px rgba(0, 0, 0, 0.5), 0 0 0 2px var(--ctp-blue, #89b4fa)'
    : isMultiSelected
      ? '0 4px 24px rgba(0, 0, 0, 0.5), 0 0 0 2px var(--ctp-blue, #89b4fa)'
      : '0 4px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(88, 91, 112, 0.15)';

  // ── Compact anchor strip ──────────────────────────────────────
  if (view.type === 'anchor') {
    const anchorView = view as AnchorCanvasViewType;
    const isCollapsedVisually = !!anchorView.autoCollapse && !anchorHovered && dragPos === null;
    const visualWidth = isCollapsedVisually ? ANCHOR_HEIGHT : currentSize.width;

    return (
      <div
        className={`absolute flex items-center bg-ctp-mantle border border-surface-0 rounded-lg select-none group/titlebar overflow-hidden ${attentionClass}`}
        style={{
          left: currentPos.x,
          top: currentPos.y,
          width: visualWidth,
          height: ANCHOR_HEIGHT,
          zIndex: view.zIndex,
          transition: dragPos ? undefined : 'width 150ms ease',
          ...(!attention && { boxShadow: selectionShadow }),
          ...(multiDragHidden && { opacity: 0, pointerEvents: 'none' as const }),
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          if (e.metaKey || e.ctrlKey) {
            onToggleSelect();
          } else if (!isMultiSelected) {
            onSelect();
          }
        }}
        onMouseEnter={() => setAnchorHovered(true)}
        onMouseLeave={() => setAnchorHovered(false)}
        data-testid={`canvas-view-${view.id}`}
        data-attention={attention?.level ?? undefined}
        data-selected={isSelected ? 'true' : undefined}
        data-multi-selected={isMultiSelected ? 'true' : undefined}
        data-collapsed={isCollapsedVisually ? 'true' : undefined}
      >
        {/* Anchor icon — always visible, acts as drag handle */}
        <div
          className="w-[50px] h-[50px] flex items-center justify-center flex-shrink-0 cursor-grab active:cursor-grabbing"
          onMouseDown={handleDragStart}
          data-testid="canvas-view-titlebar"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-ctp-blue"
          >
            <circle cx="12" cy="5" r="3" />
            <line x1="12" y1="8" x2="12" y2="22" />
            <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
          </svg>
        </div>

        {/* Expanded content — hidden when collapsed */}
        {!isCollapsedVisually && (
          <>
            <span className="text-[10px] text-ctp-overlay1 bg-surface-0 rounded px-1.5 py-0.5 font-medium leading-none flex-shrink-0">
              Anchor
            </span>

            <div
              className="flex-1 min-w-0 px-1.5 cursor-grab active:cursor-grabbing"
              onMouseDown={handleDragStart}
            >
              <InlineRename
                value={view.displayName || view.title}
                onCommit={(newName) => {
                  onUpdate({
                    displayName: newName,
                    label: newName,
                    title: newName,
                  } as Partial<AnchorCanvasViewType>);
                }}
              />
            </div>

            <div className="flex items-center gap-0.5 flex-shrink-0 pr-2">
              <button
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
                  anchorView.autoCollapse
                    ? 'text-ctp-blue bg-ctp-blue/10'
                    : 'text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate({ autoCollapse: !anchorView.autoCollapse } as Partial<AnchorCanvasViewType>);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                title={anchorView.autoCollapse ? 'Stay expanded' : 'Auto-collapse when not hovered'}
                data-testid="canvas-anchor-collapse-toggle"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="4 7 9 12 4 17" />
                  <polyline points="20 7 15 12 20 17" />
                </svg>
              </button>
              <button
                className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                onMouseDown={(e) => e.stopPropagation()}
                title="Remove anchor"
                data-testid="canvas-view-close"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </>
        )}

        {/* Horizontal resize handles only (hidden when collapsed) */}
        {!isCollapsedVisually && (
          <>
            <div
              className="absolute left-0 top-[6px] bottom-[6px] pointer-events-auto"
              style={{ width: EDGE_SIZE, cursor: 'ew-resize', zIndex: 10 }}
              onMouseDown={(e) => handleResizeStart('w', e)}
              data-testid="canvas-view-resize-w"
            />
            <div
              className="absolute right-0 top-[6px] bottom-[6px] pointer-events-auto"
              style={{ width: EDGE_SIZE, cursor: 'ew-resize', zIndex: 10 }}
              onMouseDown={(e) => handleResizeStart('e', e)}
              data-testid="canvas-view-resize-e"
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={`absolute flex flex-col bg-ctp-base border border-surface-2 rounded-lg ${attentionClass}`}
      style={{
        left: currentPos.x,
        top: currentPos.y,
        width: currentSize.width,
        height: currentSize.height,
        zIndex: view.zIndex,
        ...(!attention && { boxShadow: selectionShadow }),
        ...(multiDragHidden && { opacity: 0, pointerEvents: 'none' as const }),
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) {
          onToggleSelect();
        } else if (!isMultiSelected) {
          onSelect();
        }
      }}
      data-testid={`canvas-view-${view.id}`}
      data-attention={attention?.level ?? undefined}
      data-selected={isSelected ? 'true' : undefined}
      data-multi-selected={isMultiSelected ? 'true' : undefined}
    >
      {/* Title bar — drag handle */}
      <div
        className="group/titlebar flex items-center gap-1.5 px-2.5 py-1.5 bg-ctp-mantle border-b border-surface-0 cursor-grab active:cursor-grabbing flex-shrink-0 rounded-t-lg"
        onMouseDown={handleDragStart}
        data-testid="canvas-view-titlebar"
      >
        {/* Agent identity chip */}
        {agentInfo && <AgentAvatar agentId={agentInfo.id} size="sm" showStatusRing />}

        <span className="text-[10px] text-ctp-overlay1 bg-surface-0 rounded px-1.5 py-0.5 font-medium leading-none">
          {formatViewType(view.type === 'plugin' ? (view as PluginCanvasViewType).pluginWidgetType.split(':').pop() || '' : view.type)}
        </span>
        <InlineRename
          value={view.displayName || view.title}
          onCommit={(newName) => {
            onUpdate({ displayName: newName });
          }}
        />
        {projectContext && (
          <span className="text-[10px] text-ctp-overlay0 truncate flex-shrink-0">({projectContext})</span>
        )}

        {/* Quick action buttons */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {/* MCP Link button (agent views with assigned agent, when MCP enabled) */}
          {mcpEnabled && view.type === 'agent' && (view as AgentCanvasViewType).agentId && (
            <div className="relative">
              <button
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
                  linkDropdownOpen
                    ? 'text-ctp-blue bg-ctp-blue/10'
                    : 'text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text'
                }`}
                onClick={(e) => { e.stopPropagation(); setLinkDropdownOpen(!linkDropdownOpen); }}
                onMouseDown={(e) => e.stopPropagation()}
                title="Link to widget"
                data-testid="canvas-view-link"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </button>
              {linkDropdownOpen && allViews && (
                <LinkDropdown
                  agentView={view as AgentCanvasViewType}
                  views={allViews}
                  onClose={() => setLinkDropdownOpen(false)}
                />
              )}
            </div>
          )}
          {/* MCP Wire drag button (agent views with assigned agent, when MCP enabled) */}
          {mcpEnabled && view.type === 'agent' && (view as AgentCanvasViewType).agentId && onStartWireDrag && (
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text transition-colors"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onStartWireDrag(view as AgentCanvasViewType);
              }}
              title="Drag to connect"
              data-testid="canvas-view-wire"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="5" cy="12" r="3" />
                <circle cx="19" cy="12" r="3" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </button>
          )}
          {isAgentRunning && (
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-blue-500/20 hover:text-blue-400 transition-colors"
              onClick={(e) => { e.stopPropagation(); handleSleep(); }}
              title="Sleep agent"
              data-testid="canvas-view-sleep"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            </button>
          )}
          <button
            className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text transition-colors"
            onClick={(e) => { e.stopPropagation(); onCenterView(); }}
            title="Center on this view"
            data-testid="canvas-view-center"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
            </svg>
          </button>
          <button
            className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
              isZoomed
                ? 'text-ctp-blue bg-surface-1'
                : 'text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text'
            }`}
            onClick={(e) => { e.stopPropagation(); onZoomView(); }}
            title={isZoomed ? 'Restore view' : 'Zoom view'}
            data-testid="canvas-view-zoom"
          >
            {isZoomed ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
          <button
            className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-red-500/20 hover:text-red-400 transition-colors"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Close view"
            data-testid="canvas-view-close"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content area — allow pointer events so the first click on an
          interactive element (button, input, terminal) works immediately
          without requiring a separate click to select the widget first.
          Keyboard isolation is handled by the workspace's focus management
          (auto-focus on mount, reclaim on deselect via Escape / empty click).
          Only stop wheel propagation when this view is selected, so
          unselected views let scroll events pan the canvas.
          When the view is zoomed, the overlay renders a full-size copy of the
          content, so skip rendering here to prevent duplicate terminals from
          racing on PTY resize. */}
      <div
        className="flex-1 min-h-0 overflow-hidden rounded-b-lg"
        onWheel={isSelected ? (e) => e.stopPropagation() : undefined}
      >
        {!isZoomed && renderContent()}
      </div>

      {/* ── Resize handles (edges + corners) ─────────────────────── */}
      {/* Edge handles */}
      <div
        className="absolute top-0 left-[12px] right-[12px] pointer-events-auto"
        style={{ height: EDGE_SIZE, cursor: CURSOR_MAP.n, zIndex: 10 }}
        onMouseDown={(e) => handleResizeStart('n', e)}
        data-testid="canvas-view-resize-n"
      />
      <div
        className="absolute bottom-0 left-[12px] right-[12px] pointer-events-auto"
        style={{ height: EDGE_SIZE, cursor: CURSOR_MAP.s, zIndex: 10 }}
        onMouseDown={(e) => handleResizeStart('s', e)}
        data-testid="canvas-view-resize-s"
      />
      <div
        className="absolute left-0 top-[12px] bottom-[12px] pointer-events-auto"
        style={{ width: EDGE_SIZE, cursor: CURSOR_MAP.w, zIndex: 10 }}
        onMouseDown={(e) => handleResizeStart('w', e)}
        data-testid="canvas-view-resize-w"
      />
      <div
        className="absolute right-0 top-[12px] bottom-[12px] pointer-events-auto"
        style={{ width: EDGE_SIZE, cursor: CURSOR_MAP.e, zIndex: 10 }}
        onMouseDown={(e) => handleResizeStart('e', e)}
        data-testid="canvas-view-resize-e"
      />

      {/* Corner handles */}
      <div
        className="absolute top-0 left-0 pointer-events-auto"
        style={{ width: CORNER_SIZE, height: CORNER_SIZE, cursor: CURSOR_MAP.nw, zIndex: 11 }}
        onMouseDown={(e) => handleResizeStart('nw', e)}
        data-testid="canvas-view-resize-nw"
      />
      <div
        className="absolute top-0 right-0 pointer-events-auto"
        style={{ width: CORNER_SIZE, height: CORNER_SIZE, cursor: CURSOR_MAP.ne, zIndex: 11 }}
        onMouseDown={(e) => handleResizeStart('ne', e)}
        data-testid="canvas-view-resize-ne"
      />
      <div
        className="absolute bottom-0 left-0 pointer-events-auto"
        style={{ width: CORNER_SIZE, height: CORNER_SIZE, cursor: CURSOR_MAP.sw, zIndex: 11 }}
        onMouseDown={(e) => handleResizeStart('sw', e)}
        data-testid="canvas-view-resize-sw"
      />
      <div
        className="absolute bottom-0 right-0 pointer-events-auto"
        style={{ width: CORNER_SIZE, height: CORNER_SIZE, cursor: CURSOR_MAP.se, zIndex: 11 }}
        onMouseDown={(e) => handleResizeStart('se', e)}
        data-testid="canvas-view-resize-se"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" className="text-ctp-overlay0 absolute bottom-0 right-0">
          <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1" />
          <line x1="10" y1="6" x2="6" y2="10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
