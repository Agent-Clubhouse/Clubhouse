import React, { useMemo, useState, useCallback } from 'react';
import type { CanvasView, CanvasViewAttention, PluginCanvasView } from './canvas-types';
import type { CanvasWidgetMetadata, PluginAPI } from '../../../../shared/plugin-types';
import type { RegisteredCanvasWidget } from '../../canvas-widget-registry';
import { CanvasSearch } from './CanvasSearch';
import { useAttentionCycler } from './canvas-attention';

/** Hook for cycling through anchor views on the canvas. */
export function useAnchorCycler(
  views: CanvasView[],
  onNavigate: (viewId: string) => void,
): {
  count: number;
  currentIndex: number;
  goNext: () => void;
  goPrev: () => void;
} {
  const [currentIndex, setCurrentIndex] = useState(0);
  const anchorIds = useMemo(
    () => views.filter((v) => v.type === 'anchor').map((v) => v.id),
    [views],
  );
  const count = anchorIds.length;

  const goNext = useCallback(() => {
    if (count === 0) return;
    const next = (currentIndex + 1) % count;
    setCurrentIndex(next);
    onNavigate(anchorIds[next]);
  }, [count, currentIndex, anchorIds, onNavigate]);

  const goPrev = useCallback(() => {
    if (count === 0) return;
    const prev = (currentIndex - 1 + count) % count;
    setCurrentIndex(prev);
    onNavigate(anchorIds[prev]);
  }, [count, currentIndex, anchorIds, onNavigate]);

  // Reset index when out of bounds
  const safeIndex = count > 0 ? Math.min(currentIndex, count - 1) : 0;
  if (safeIndex !== currentIndex && count > 0) {
    setCurrentIndex(safeIndex);
  }

  return { count, currentIndex: safeIndex, goNext, goPrev };
}

export interface ForceLayoutSettings {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

const DEFAULT_FORCE_SETTINGS: ForceLayoutSettings = {
  centerForce: 0.1,
  repelForce: 5000,
  linkForce: 0.3,
  linkDistance: 300,
};

interface CanvasControlsProps {
  zoom: number;
  hasViews?: boolean;
  views: CanvasView[];
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onCenter: () => void;
  onSizeToFit: () => void;
  onSelectView: (viewId: string) => void;
  onAutoLayout?: (settings: ForceLayoutSettings) => void;
  onElkLayout?: () => void;
  attentionMap?: Map<string, CanvasViewAttention>;
  api?: PluginAPI;
  pinnedWidgets?: Array<{
    view: PluginCanvasView;
    registered: RegisteredCanvasWidget;
    onUpdateMetadata: (updates: CanvasWidgetMetadata) => void;
  }>;
}

export function CanvasControls({ zoom, hasViews, views, onZoomIn, onZoomOut, onZoomReset, onCenter, onSizeToFit, onSelectView, onAutoLayout, onElkLayout, attentionMap, api: _api, pinnedWidgets: _pinnedWidgets }: CanvasControlsProps) {
  const zoomPercent = Math.round(zoom * 100);
  const effectiveMap = attentionMap ?? new Map();
  const { count, goNext, goPrev } = useAttentionCycler(effectiveMap, onSelectView);
  const { count: anchorCount, goNext: anchorNext, goPrev: anchorPrev } = useAnchorCycler(views, onSelectView);
  const [showLayoutSettings, setShowLayoutSettings] = useState(false);
  const [forceSettings, setForceSettings] = useState<ForceLayoutSettings>(DEFAULT_FORCE_SETTINGS);
  const [layoutMode, setLayoutMode] = useState<'force' | 'elk'>('force');

  const btnClass = 'w-6 h-6 flex items-center justify-center rounded text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors';

  return (
    <div
      className="absolute top-3 right-3 flex items-center gap-1 bg-ctp-mantle/90 backdrop-blur-sm rounded-lg border border-surface-0 px-1.5 py-1 shadow-sm"
      data-testid="canvas-controls"
    >
      {/* Attention cycling */}
      {count > 0 && (
        <>
          <div className="flex items-center gap-0.5" data-testid="canvas-attention-cycler">
            <button
              onClick={goPrev}
              className="w-5 h-5 flex items-center justify-center rounded text-ctp-warning hover:bg-yellow-500/20 transition-colors"
              title="Previous attention item"
              data-testid="canvas-attention-prev"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <div
              className="flex items-center gap-1 px-1"
              title={`${count} card${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} attention`}
            >
              {/* Exclamation icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ctp-warning">
                <path
                  d="M12 2L2 22h20L12 2z"
                  fill="currentColor"
                  fillOpacity="0.15"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <line x1="12" y1="10" x2="12" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <circle cx="12" cy="17.5" r="1" fill="currentColor" />
              </svg>
              <span className="text-[10px] font-mono text-ctp-warning min-w-[2ch] text-center">
                {count}
              </span>
            </div>
            <button
              onClick={goNext}
              className="w-5 h-5 flex items-center justify-center rounded text-ctp-warning hover:bg-yellow-500/20 transition-colors"
              title="Next attention item"
              data-testid="canvas-attention-next"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
          <div className="w-px h-4 bg-surface-0 mx-0.5" />
        </>
      )}

      {/* Anchor cycling */}
      {anchorCount > 0 && (
        <>
          <div className="flex items-center gap-0.5" data-testid="canvas-anchor-cycler">
            <button
              onClick={anchorPrev}
              className="w-5 h-5 flex items-center justify-center rounded text-ctp-blue hover:bg-ctp-blue/20 transition-colors"
              title="Previous anchor"
              data-testid="canvas-anchor-prev"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <div
              className="flex items-center gap-1 px-1"
              title={`${anchorCount} anchor${anchorCount !== 1 ? 's' : ''}`}
            >
              {/* Anchor icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ctp-blue" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="5" r="3" />
                <line x1="12" y1="8" x2="12" y2="22" />
                <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
              </svg>
              <span className="text-[10px] font-mono text-ctp-blue min-w-[2ch] text-center">
                {anchorCount}
              </span>
            </div>
            <button
              onClick={anchorNext}
              className="w-5 h-5 flex items-center justify-center rounded text-ctp-blue hover:bg-ctp-blue/20 transition-colors"
              title="Next anchor"
              data-testid="canvas-anchor-next"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
          <div className="w-px h-4 bg-surface-0 mx-0.5" />
        </>
      )}

      {/* Search */}
      {hasViews && <CanvasSearch views={views} onSelectView={onSelectView} />}

      {hasViews && <div className="w-px h-4 bg-surface-0 mx-0.5" />}

      {/* Center viewport */}
      <button
        onClick={onCenter}
        className={btnClass}
        title="Center viewport"
        data-testid="canvas-center"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="2" x2="12" y2="6" />
          <line x1="12" y1="18" x2="12" y2="22" />
          <line x1="2" y1="12" x2="6" y2="12" />
          <line x1="18" y1="12" x2="22" y2="12" />
        </svg>
      </button>

      {/* Size to fit */}
      {hasViews && (
        <button
          onClick={onSizeToFit}
          className={btnClass}
          title="Size to fit all views"
          data-testid="canvas-size-to-fit"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <rect x="7" y="7" width="10" height="10" rx="1" />
          </svg>
        </button>
      )}

      {/* Auto Layout */}
      {hasViews && onAutoLayout && (
        <div className="relative flex items-center gap-0.5">
          <button
            onClick={() => layoutMode === 'elk' && onElkLayout ? onElkLayout() : onAutoLayout(forceSettings)}
            className={btnClass}
            title={layoutMode === 'elk' ? 'Auto Layout (ELK layered)' : 'Auto Layout (force-directed)'}
            data-testid="canvas-auto-layout"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {/* Flow graph: left node branching to two right nodes */}
              <rect x="2" y="9" width="6" height="6" rx="1" />
              <rect x="16" y="3" width="6" height="6" rx="1" />
              <rect x="16" y="15" width="6" height="6" rx="1" />
              <path d="M 8 12 L 12 12 L 12 6 L 16 6" />
              <path d="M 12 12 L 12 18 L 16 18" />
            </svg>
          </button>
          <button
            onClick={() => setShowLayoutSettings(!showLayoutSettings)}
            className="w-4 h-6 flex items-center justify-center rounded text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors"
            title="Layout settings"
            data-testid="canvas-auto-layout-settings-toggle"
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <polyline points={showLayoutSettings ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
            </svg>
          </button>
          {showLayoutSettings && (
            <div
              className="absolute top-full right-0 mt-1 w-56 bg-ctp-mantle border border-surface-0 rounded-lg shadow-lg p-3 z-50"
              data-testid="canvas-auto-layout-settings"
            >
              <div className="text-[10px] font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">Layout Mode</div>
              <div className="flex gap-1 mb-3" data-testid="layout-mode-toggle">
                <button
                  onClick={() => setLayoutMode('force')}
                  className={`flex-1 text-[10px] py-1 rounded transition-colors ${layoutMode === 'force' ? 'bg-ctp-accent text-ctp-crust font-semibold' : 'bg-surface-0 text-ctp-subtext0 hover:text-ctp-text'}`}
                >
                  Force
                </button>
                <button
                  onClick={() => setLayoutMode('elk')}
                  className={`flex-1 text-[10px] py-1 rounded transition-colors ${layoutMode === 'elk' ? 'bg-ctp-accent text-ctp-crust font-semibold' : 'bg-surface-0 text-ctp-subtext0 hover:text-ctp-text'}`}
                >
                  ELK
                </button>
              </div>
              {layoutMode === 'force' && <>
              <div className="text-[10px] font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">Force Settings</div>
              <label className="flex items-center justify-between text-[11px] text-ctp-text mb-1.5">
                <span>Center Force</span>
                <input
                  type="range" min="0" max="100" step="1"
                  value={Math.round(forceSettings.centerForce * 100)}
                  onChange={(e) => setForceSettings(s => ({ ...s, centerForce: Number(e.target.value) / 100 }))}
                  className="w-20 h-1 accent-ctp-blue"
                  data-testid="force-center-slider"
                />
              </label>
              <label className="flex items-center justify-between text-[11px] text-ctp-text mb-1.5">
                <span>Repel Force</span>
                <input
                  type="range" min="100" max="20000" step="100"
                  value={forceSettings.repelForce}
                  onChange={(e) => setForceSettings(s => ({ ...s, repelForce: Number(e.target.value) }))}
                  className="w-20 h-1 accent-ctp-blue"
                  data-testid="force-repel-slider"
                />
              </label>
              <label className="flex items-center justify-between text-[11px] text-ctp-text mb-1.5">
                <span>Link Force</span>
                <input
                  type="range" min="0" max="100" step="1"
                  value={Math.round(forceSettings.linkForce * 100)}
                  onChange={(e) => setForceSettings(s => ({ ...s, linkForce: Number(e.target.value) / 100 }))}
                  className="w-20 h-1 accent-ctp-blue"
                  data-testid="force-link-slider"
                />
              </label>
              <label className="flex items-center justify-between text-[11px] text-ctp-text mb-2">
                <span>Link Distance</span>
                <input
                  type="range" min="100" max="800" step="20"
                  value={forceSettings.linkDistance}
                  onChange={(e) => setForceSettings(s => ({ ...s, linkDistance: Number(e.target.value) }))}
                  className="w-20 h-1 accent-ctp-blue"
                  data-testid="force-distance-slider"
                />
              </label>
              <button
                onClick={() => setForceSettings(DEFAULT_FORCE_SETTINGS)}
                className="w-full text-[10px] text-ctp-subtext0 hover:text-ctp-text py-0.5 rounded hover:bg-surface-1 transition-colors"
                data-testid="force-reset-defaults"
              >
                Reset to defaults
              </button>
              </>}
            </div>
          )}
        </div>
      )}

      {/* Divider */}
      <div className="w-px h-4 bg-surface-0 mx-0.5" />

      {/* Zoom controls */}
      <button
        onClick={onZoomOut}
        className={btnClass}
        title="Zoom out"
        data-testid="canvas-zoom-out"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        onClick={onZoomReset}
        className="min-w-[3rem] h-6 flex items-center justify-center rounded text-[10px] text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors font-mono"
        title="Reset zoom"
        data-testid="canvas-zoom-reset"
      >
        {zoomPercent}%
      </button>
      <button
        onClick={onZoomIn}
        className={btnClass}
        title="Zoom in"
        data-testid="canvas-zoom-in"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}
