import React, { useMemo, useState, useCallback, useEffect } from 'react';
import type { CanvasView, CanvasViewAttention, PluginCanvasView } from './canvas-types';
import type { CanvasWidgetMetadata, PluginAPI } from '../../../../shared/plugin-types';
import type { RegisteredCanvasWidget } from '../../canvas-widget-registry';
import { CanvasSearch } from './CanvasSearch';
import { useAttentionCycler } from './canvas-attention';
import type { ElkAlgorithm, LayeredDirection } from '../../../../main/services/clubhouse-mcp/elk-layout';
import { Tooltip } from '../../../components/Tooltip';

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

  // Reset index when out of bounds (in useEffect to avoid state update during render)
  const safeIndex = count > 0 ? Math.min(currentIndex, count - 1) : 0;
  useEffect(() => {
    if (safeIndex !== currentIndex && count > 0) {
      setCurrentIndex(safeIndex);
    }
  }, [safeIndex, currentIndex, count]);

  return { count, currentIndex: safeIndex, goNext, goPrev };
}

export interface AutolayoutOptions {
  algorithm: ElkAlgorithm;
  direction?: LayeredDirection;
  /** Root node for radial — filled in by the workspace from selectedViewId. */
  rootId?: string;
}

const ALGORITHM_LABELS: Record<ElkAlgorithm, string> = {
  layered: 'Layered',
  radial: 'Radial',
  force: 'Force',
  mrtree: 'Tree',
};

const ALGORITHM_DESCRIPTIONS: Record<ElkAlgorithm, string> = {
  layered: 'Hierarchical flow with spline routing',
  radial: 'Concentric circles from selected card',
  force: 'Physics-based node spreading',
  mrtree: 'Compact tree hierarchy',
};

const DIRECTION_LABELS: Record<LayeredDirection, string> = {
  RIGHT: '\u2192',
  DOWN: '\u2193',
  LEFT: '\u2190',
  UP: '\u2191',
};

const DIRECTIONS: LayeredDirection[] = ['RIGHT', 'DOWN', 'LEFT', 'UP'];
const ALGORITHMS: ElkAlgorithm[] = ['layered', 'radial', 'force', 'mrtree'];

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
  onAutolayout?: (options: AutolayoutOptions) => void;
  hasSelection?: boolean;
  elkAlgorithm?: ElkAlgorithm;
  elkDirection?: LayeredDirection;
  layoutCenterId?: string | null;
  onElkAlgorithmChange?: (algorithm: ElkAlgorithm) => void;
  onElkDirectionChange?: (direction: LayeredDirection) => void;
  attentionMap?: Map<string, CanvasViewAttention>;
  api?: PluginAPI;
  pinnedWidgets?: Array<{
    view: PluginCanvasView;
    registered: RegisteredCanvasWidget;
    onUpdateMetadata: (updates: CanvasWidgetMetadata) => void;
  }>;
}

export function CanvasControls({ zoom, hasViews, views, onZoomIn, onZoomOut, onZoomReset, onCenter, onSizeToFit, onSelectView, onAutolayout, hasSelection, elkAlgorithm: storedAlgorithm, elkDirection: storedDirection, layoutCenterId, onElkAlgorithmChange, onElkDirectionChange, attentionMap, api: _api, pinnedWidgets: _pinnedWidgets }: CanvasControlsProps) {
  const zoomPercent = Math.round(zoom * 100);
  const effectiveMap = attentionMap ?? new Map();
  const { count, goNext, goPrev } = useAttentionCycler(effectiveMap, onSelectView);
  const { count: anchorCount, goNext: anchorNext, goPrev: anchorPrev } = useAnchorCycler(views, onSelectView);
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const algorithm = storedAlgorithm ?? 'layered';
  const direction = storedDirection ?? 'RIGHT';
  const setAlgorithm = useCallback((alg: ElkAlgorithm) => onElkAlgorithmChange?.(alg), [onElkAlgorithmChange]);
  const setDirection = useCallback((dir: LayeredDirection) => onElkDirectionChange?.(dir), [onElkDirectionChange]);

  const btnClass = 'w-7 h-7 flex items-center justify-center rounded-md text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text transition-colors';

  const handleLayout = useCallback(() => {
    if (!onAutolayout) return;
    onAutolayout({ algorithm, direction: algorithm === 'layered' || algorithm === 'mrtree' ? direction : undefined });
  }, [onAutolayout, algorithm, direction]);

  const handleAlgorithmSelect = useCallback((alg: ElkAlgorithm) => {
    setAlgorithm(alg);
    if (!onAutolayout) return;
    onAutolayout({ algorithm: alg, direction: alg === 'layered' || alg === 'mrtree' ? direction : undefined });
    setShowLayoutMenu(false);
  }, [onAutolayout, direction]);

  return (
    <div
      className="absolute top-2.5 right-2.5 flex items-center gap-0.5 bg-ctp-mantle rounded-lg border border-surface-1 p-0.5 z-raised"
      data-testid="canvas-controls"
    >
      {/* Attention cycling */}
      {count > 0 && (
        <>
          <div className="flex items-center gap-0.5" data-testid="canvas-attention-cycler">
            <Tooltip content="Previous attention item">
              <button
                onClick={goPrev}
                className={btnClass}
                aria-label="Previous attention item"
                data-testid="canvas-attention-prev"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            </Tooltip>
            <div
              className="flex items-center gap-1.5 px-1"
              title={`${count} card${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} you`}
            >
              <span className="w-2 h-2 rounded-full bg-ctp-warning flex-shrink-0" aria-hidden="true" />
              <span className="text-xs text-ctp-text whitespace-nowrap">
                {count} need{count === 1 ? 's' : ''} you
              </span>
            </div>
            <Tooltip content="Next attention item">
              <button
                onClick={goNext}
                className={btnClass}
                aria-label="Next attention item"
                data-testid="canvas-attention-next"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </Tooltip>
          </div>
          <div className="w-px h-4 bg-surface-1 mx-0.5" />
        </>
      )}

      {/* Anchor cycling */}
      {anchorCount > 0 && (
        <>
          <div className="flex items-center gap-0.5" data-testid="canvas-anchor-cycler">
            <Tooltip content="Previous anchor">
              <button
                onClick={anchorPrev}
                className={btnClass}
                aria-label="Previous anchor"
                data-testid="canvas-anchor-prev"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            </Tooltip>
            <div
              className="flex items-center gap-1 px-1"
              title={`${anchorCount} anchor${anchorCount !== 1 ? 's' : ''}`}
            >
              {/* Anchor icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ctp-overlay1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="5" r="3" />
                <line x1="12" y1="8" x2="12" y2="22" />
                <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
              </svg>
              <span className="text-xs text-ctp-subtext1 min-w-[2ch] text-center">
                {anchorCount}
              </span>
            </div>
            <Tooltip content="Next anchor">
              <button
                onClick={anchorNext}
                className={btnClass}
                aria-label="Next anchor"
                data-testid="canvas-anchor-next"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </Tooltip>
          </div>
          <div className="w-px h-4 bg-surface-1 mx-0.5" />
        </>
      )}

      {/* Search */}
      {hasViews && <CanvasSearch views={views} onSelectView={onSelectView} />}

      {hasViews && <div className="w-px h-4 bg-surface-1 mx-0.5" />}

      {/* Center viewport */}
      <Tooltip content="Center viewport">
        <button
          onClick={onCenter}
          className={btnClass}
          aria-label="Center viewport"
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
      </Tooltip>

      {/* Size to fit */}
      {hasViews && (
        <Tooltip content="Size to fit all views">
          <button
            onClick={onSizeToFit}
            className={btnClass}
            aria-label="Size to fit all views"
            data-testid="canvas-size-to-fit"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <rect x="7" y="7" width="10" height="10" rx="1" />
            </svg>
          </button>
        </Tooltip>
      )}

      {/* Auto Layout */}
      {hasViews && onAutolayout && (
        <div className="relative flex items-center gap-0.5">
          <Tooltip content={`Auto layout (${ALGORITHM_LABELS[algorithm]}${algorithm === 'layered' || algorithm === 'mrtree' ? ' ' + DIRECTION_LABELS[direction] : ''})`}>
            <button
              onClick={handleLayout}
              className={btnClass}
              aria-label={`Auto layout (${ALGORITHM_LABELS[algorithm]}${algorithm === 'layered' || algorithm === 'mrtree' ? ' ' + DIRECTION_LABELS[direction] : ''})`}
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
          </Tooltip>
          <Tooltip content="Layout options">
            <button
              onClick={() => setShowLayoutMenu(!showLayoutMenu)}
              className="w-4 h-7 flex items-center justify-center rounded-md text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text transition-colors"
              aria-label="Layout options"
              data-testid="canvas-auto-layout-menu-toggle"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <polyline points={showLayoutMenu ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
              </svg>
            </button>
          </Tooltip>
          {showLayoutMenu && (
            <div
              className="absolute top-full right-0 mt-1 w-60 bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl p-1 z-dropdown"
              data-testid="canvas-auto-layout-menu"
            >
              <div className="h-6 flex items-center px-2 text-xs text-ctp-overlay1">Auto layout</div>
              {ALGORITHMS.map((alg) => (
                <button
                  key={alg}
                  onClick={() => handleAlgorithmSelect(alg)}
                  role="menuitemradio"
                  aria-checked={algorithm === alg}
                  className="w-full text-left px-2 py-1.5 rounded-md text-xs text-ctp-text hover:bg-surface-0 transition-colors flex items-center justify-between"
                  data-testid={`layout-algorithm-${alg}`}
                >
                  <div>
                    <div>{ALGORITHM_LABELS[alg]}</div>
                    <div className="text-xs text-ctp-overlay1">{ALGORITHM_DESCRIPTIONS[alg]}</div>
                  </div>
                  {algorithm === alg && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))}

              {/* Direction picker for layered/mrtree */}
              {(algorithm === 'layered' || algorithm === 'mrtree') && (
                <>
                  <div className="w-full h-px bg-surface-0 my-1" />
                  <div className="h-6 flex items-center px-2 text-xs text-ctp-overlay1">Direction</div>
                  <div className="flex gap-0.5 px-1 pb-1" data-testid="layout-direction-picker">
                    {DIRECTIONS.map((dir) => (
                      <Tooltip content={dir.charAt(0) + dir.slice(1).toLowerCase()}>
                        <button
                          key={dir}
                          onClick={() => {
                            setDirection(dir);
                            if (onAutolayout) onAutolayout({ algorithm, direction: dir });
                          }}
                          aria-pressed={direction === dir}
                          className={`flex-1 h-7 text-center text-[13px] rounded-md transition-colors ${
                            direction === dir
                              ? 'bg-surface-1 text-ctp-text'
                              : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text'
                          }`}
                          aria-label={dir.charAt(0) + dir.slice(1).toLowerCase()}
                          data-testid={`layout-direction-${dir.toLowerCase()}`}
                        >
                          {DIRECTION_LABELS[dir]}
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                </>
              )}

              {/* Radial hint */}
              {algorithm === 'radial' && (
                <>
                  <div className="w-full h-px bg-surface-0 my-1" />
                  <div className="text-xs text-ctp-overlay1 px-2 py-1">
                    {hasSelection
                      ? 'Radiates from the selected card'
                      : layoutCenterId
                        ? 'Radiates from the layout center. Right-click a card to change it.'
                        : 'Select a card, or right-click one and choose Set as layout center.'}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Divider */}
      <div className="w-px h-4 bg-surface-1 mx-0.5" />

      {/* Zoom controls */}
      <Tooltip content="Zoom out">
        <button
          onClick={onZoomOut}
          className={btnClass}
          aria-label="Zoom out"
          data-testid="canvas-zoom-out"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip content="Reset zoom">
        <button
          onClick={onZoomReset}
          className="min-w-[3rem] h-7 px-1 flex items-center justify-center rounded-md text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text transition-colors tabular-nums"
          aria-label="Reset zoom"
          data-testid="canvas-zoom-reset"
        >
          {zoomPercent}%
        </button>
      </Tooltip>
      <Tooltip content="Zoom in">
        <button
          onClick={onZoomIn}
          className={btnClass}
          aria-label="Zoom in"
          data-testid="canvas-zoom-in"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
