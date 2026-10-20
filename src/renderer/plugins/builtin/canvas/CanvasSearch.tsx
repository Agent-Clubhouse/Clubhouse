import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { CanvasView } from './canvas-types';
import { Tooltip, formatShortcut } from '../../../components/Tooltip';
import { keyPlatform } from '../../../editing-keys';

interface CanvasSearchProps {
  views: CanvasView[];
  onSelectView: (viewId: string) => void;
}

/** Friendly labels for built-in view types. */
const TYPE_LABELS: Record<string, string> = {
  agent: 'Agent',
  anchor: 'Anchor',
  plugin: 'Plugin',
};

/** Build a flat searchable string from a view's identity fields. */
function buildSearchableText(view: CanvasView): string {
  const parts: string[] = [
    view.displayName,
    view.title,
    view.type,
    TYPE_LABELS[view.type] ?? '',
  ];
  // Include metadata values
  for (const [key, val] of Object.entries(view.metadata)) {
    if (val != null) {
      parts.push(String(key), String(val));
    }
  }
  // Type-specific fields
  if (view.type === 'agent' && view.agentId) parts.push(view.agentId);
  if (view.type === 'anchor') parts.push(view.label);
  if (view.type === 'plugin') parts.push(view.pluginWidgetType);

  return parts.join(' ').toLowerCase();
}

export function CanvasSearch({ views, onSelectView }: CanvasSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  /** Tracks whether the user has started cycling through results via Enter. */
  const [cycling, setCycling] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter views based on query
  const filteredViews = useMemo(() => {
    if (!query.trim()) return views;
    const terms = query.toLowerCase().trim().split(/\s+/);
    return views.filter((view) => {
      const text = buildSearchableText(view);
      return terms.every((term) => text.includes(term));
    });
  }, [views, query]);

  // Reset selected index and cycling state when query or results change
  useEffect(() => {
    setSelectedIndex(0);
    setCycling(false);
  }, [filteredViews.length, query]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Return focus to the workspace so Cmd+F continues to work after close
  const focusWorkspace = useCallback(() => {
    const workspace = document.querySelector<HTMLElement>('[data-testid="canvas-workspace"]');
    workspace?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setQuery('');
        setCycling(false);
        focusWorkspace();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, focusWorkspace]);

  // Keyboard shortcut: Cmd/Ctrl+F to open search when canvas is focused.
  // Not Ctrl+F on macOS: that moves the caret forward in a text field (#2314).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((keyPlatform() === 'darwin' ? e.metaKey : e.ctrlKey) && e.key === 'f') {
        // Intercept if focus is within the canvas panel (workspace + tab bar)
        const panel = document.querySelector('[data-testid="canvas-panel"]');
        if (panel && panel.contains(document.activeElement)) {
          e.preventDefault();
          setIsOpen(true);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  /** Navigate to a result and close search (used by click). */
  const handleSelect = useCallback((viewId: string) => {
    onSelectView(viewId);
    setIsOpen(false);
    setQuery('');
    setCycling(false);
    focusWorkspace();
  }, [onSelectView, focusWorkspace]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filteredViews.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredViews.length === 0) return;
      if (filteredViews.length === 1) {
        // Only one match — navigate and close
        handleSelect(filteredViews[0].id);
        return;
      }
      // Multiple matches: navigate to current, then advance for next Enter
      const current = filteredViews[selectedIndex];
      if (current) onSelectView(current.id);
      setCycling(true);
      setSelectedIndex((i) => (i + 1) % filteredViews.length);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setQuery('');
      setCycling(false);
      focusWorkspace();
    }
  }, [filteredViews, selectedIndex, handleSelect, onSelectView, focusWorkspace]);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => {
      if (prev) {
        setQuery('');
        setCycling(false);
        focusWorkspace();
      }
      return !prev;
    });
  }, [focusWorkspace]);

  const btnClass = 'w-7 h-7 flex items-center justify-center rounded-md text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text transition-colors';

  if (!isOpen) {
    return (
      <Tooltip content={`Search views (${formatShortcut('Meta+F')})`}>
        <button
          onClick={handleToggle}
          className={btnClass}
          aria-label={`Search views (${formatShortcut('Meta+F')})`}
          data-testid="canvas-search-toggle"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
      </Tooltip>
    );
  }

  return (
    <div ref={containerRef} className="relative" data-testid="canvas-search-container">
      <div className="flex items-center gap-1">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search cards…"
            className="w-48 h-7 pl-6 pr-2 text-xs bg-ctp-base border border-surface-1 rounded-md text-ctp-text placeholder:text-ctp-overlay1 focus-ring-dim"
            data-testid="canvas-search-input"
          />
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-ctp-overlay1"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        {/* Match counter — shown when cycling through multiple results */}
        {cycling && query.trim() && filteredViews.length > 1 && (
          <span className="text-xs text-ctp-overlay0 tabular-nums whitespace-nowrap" data-testid="canvas-search-match-count">
            {((selectedIndex - 1 + filteredViews.length) % filteredViews.length) + 1} / {filteredViews.length}
          </span>
        )}
        <Tooltip content="Close search">
          <button
            onClick={handleToggle}
            className={btnClass}
            aria-label="Close search"
            data-testid="canvas-search-close"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </Tooltip>
      </div>

      {/* Results dropdown */}
      <div
        className="absolute top-9 right-0 w-64 max-h-64 overflow-y-auto py-1 bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl z-dropdown"
        data-testid="canvas-search-results"
      >
        {filteredViews.length === 0 ? (
          <div className="px-3 py-1.5 text-xs text-ctp-overlay1">No matching cards</div>
        ) : (
          filteredViews.map((view, index) => (
            <button
              key={view.id}
              className={`w-full text-left h-7 px-3 flex items-center gap-2 text-xs transition-colors ${
                index === selectedIndex
                  ? 'bg-surface-0 text-ctp-text'
                  : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
              }`}
              onClick={() => handleSelect(view.id)}
              onMouseEnter={() => setSelectedIndex(index)}
              data-testid={`canvas-search-result-${view.id}`}
            >
              <span className="truncate flex-1">{view.displayName || view.title}</span>
              <span className="text-xs text-ctp-overlay1 flex-shrink-0">
                {TYPE_LABELS[view.type] ?? view.type}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
