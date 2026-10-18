/**
 * ZoneCard — the small control card rendered at the top-left of a zone.
 * Shows zone name, theme color dot (opens picker), and delete button.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ZoneCanvasView } from './canvas-types';
import { ZONE_CARD_HEIGHT, ZONE_CARD_WIDTH } from './canvas-types';
import { InlineRename } from './InlineRename';
import { getAllThemeIds, getTheme } from '../../../themes';
import { CANVAS_Z } from './canvas-chrome';
import { Tooltip } from '../../../components/Tooltip';

interface ZoneCardProps {
  zone: ZoneCanvasView;
  mcpEnabled: boolean;
  /** Offset to apply during drag. */
  dragOffset?: { dx: number; dy: number };
  onRename: (name: string) => void;
  onThemeChange: (themeId: string) => void;
  onDelete: () => void;
  onDragStart: (e: React.MouseEvent) => void;
  onStartWireDrag: () => void;
}

export const ZoneCard = React.memo(function ZoneCard({ zone, mcpEnabled, dragOffset, onRename, onThemeChange, onDelete, onDragStart, onStartWireDrag }: ZoneCardProps) {
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const currentTheme = getTheme(zone.themeId);

  // Close theme picker on outside click
  useEffect(() => {
    if (!themePickerOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (!buttonRef.current || !buttonRef.current.contains(target)) &&
        (!pickerRef.current || !pickerRef.current.contains(target))
      ) {
        setThemePickerOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [themePickerOpen]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  }, [onDelete]);

  return (
    <div
      className="absolute flex items-center bg-ctp-mantle/90 border border-surface-0 rounded-lg select-none backdrop-blur-sm group/titlebar"
      style={{
        left: zone.position.x,
        top: zone.position.y,
        width: ZONE_CARD_WIDTH,
        height: ZONE_CARD_HEIGHT,
        zIndex: zone.zIndex + 1,
        transition: 'box-shadow 0.15s ease',
        ...(dragOffset && {
          transform: `translate(${dragOffset.dx}px, ${dragOffset.dy}px)`,
          willChange: 'transform',
          boxShadow: 'var(--shadow-elevation), 0 4px 12px rgba(0, 0, 0, 0.4), 0 0 0 2px rgb(var(--ctp-accent))',
        }),
      }}
      data-testid={`zone-card-${zone.id}`}
    >
      {/* Zone icon — drag handle */}
      <div
        className="w-[50px] h-[50px] flex items-center justify-center flex-shrink-0 cursor-grab active:cursor-grabbing text-ctp-overlay0"
        onMouseDown={onDragStart}
        data-testid={`zone-drag-handle-${zone.id}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      </div>

      {/* Zone name */}
      <div className="flex-1 min-w-0 mr-1">
        <InlineRename value={zone.displayName} onCommit={onRename} />
      </div>

      {/* Theme color dot */}
      <Tooltip content="Zone theme">
        <button
          ref={buttonRef}
          className="w-7 h-7 flex items-center justify-center rounded-md flex-shrink-0 hover:bg-surface-0"
          onClick={(e) => { e.stopPropagation(); setThemePickerOpen(!themePickerOpen); }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Zone theme"
          aria-expanded={themePickerOpen}
        >
          <span
            className="w-4 h-4 rounded-full border border-surface-2"
            style={{ backgroundColor: currentTheme?.colors.accent ?? 'rgb(var(--ctp-accent))' }}
            aria-hidden="true"
          />
        </button>
      </Tooltip>
      {themePickerOpen && createPortal(
        <ZoneThemePicker
          ref={pickerRef}
          currentThemeId={zone.themeId}
          onSelect={(id) => { onThemeChange(id); setThemePickerOpen(false); }}
          anchorRef={buttonRef}
        />,
        document.body,
      )}

      {/* Wire handle — only when MCP enabled */}
      {mcpEnabled && (
        <Tooltip content="Connect zone">
        <button
          className="w-7 h-7 flex items-center justify-center rounded-md text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text flex-shrink-0"
          onClick={(e) => { e.stopPropagation(); onStartWireDrag(); }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Connect zone"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="5" cy="12" r="3" />
            <circle cx="19" cy="12" r="3" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        </button>
        </Tooltip>
      )}

      {/* Delete button */}
      <Tooltip content="Delete zone">
      <button
        className="w-7 h-7 flex items-center justify-center rounded-md text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-error mr-1 flex-shrink-0"
        onClick={handleDeleteClick}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label="Delete zone"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      </Tooltip>
    </div>
  );
});

// ── Theme Picker Dropdown ──────────────────────────────────────────

interface ZoneThemePickerProps {
  currentThemeId: string;
  onSelect: (themeId: string) => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

const ZoneThemePicker = React.forwardRef<HTMLDivElement, ZoneThemePickerProps>(
  function ZoneThemePicker({ currentThemeId, onSelect, anchorRef }, ref) {
    const themeIds = getAllThemeIds();
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return null;

    return (
      <div
        ref={ref}
        className="fixed bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl p-2 min-w-[200px]"
        style={{
          top: rect.bottom + 8,
          left: rect.left + rect.width / 2,
          transform: 'translateX(-50%)',
          zIndex: CANVAS_Z.zonePopover,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        data-testid="zone-theme-picker"
      >
        <div className="grid grid-cols-2 gap-1.5 max-h-[300px] overflow-y-auto">
          {themeIds.map((id) => {
            const theme = getTheme(id);
            if (!theme) return null;
            const selected = id === currentThemeId;
            return (
              <button
                key={id}
                onClick={(e) => { e.stopPropagation(); onSelect(id); }}
                className={`flex flex-col rounded-md border-2 p-2 transition-all cursor-pointer ${
                  selected
                    ? 'border-ctp-accent'
                    : 'border-transparent hover:border-surface-2'
                }`}
                style={{ backgroundColor: theme.colors.base }}
              >
                <div className="flex gap-1 mb-1">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: theme.colors.mantle }} />
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: theme.colors.text }} />
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: theme.colors.accent }} />
                </div>
                <span className="text-xs font-medium text-left truncate w-full" style={{ color: theme.colors.text }}>
                  {theme.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);
