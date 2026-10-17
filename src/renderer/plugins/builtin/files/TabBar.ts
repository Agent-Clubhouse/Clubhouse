import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import { fileState } from './state';
import type { Tab } from './state';
import { getFileIconColor } from './file-icons';
import { PopupMenu, type MenuItem } from '../../../chrome/sidebar/ProjectMenu';

// ── Helpers ──────────────────────────────────────────────────────────

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

// ── Icons ────────────────────────────────────────────────────────────

function FileIconSvg({ color }: { color: string }) {
  return React.createElement('svg', {
    width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    className: `${color} flex-shrink-0`,
  },
    React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
    React.createElement('polyline', { points: '14 2 14 8 20 8' }),
  );
}

function _PinIcon() {
  return React.createElement('svg', {
    width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    className: 'text-ctp-subtext0',
  },
    React.createElement('line', { x1: 12, y1: 17, x2: 12, y2: 22 }),
    React.createElement('path', { d: 'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z' }),
  );
}

const ChevronLeftIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '15 18 9 12 15 6' }));

const ChevronRightIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '9 6 15 12 9 18' }));

// ── Individual Tab ───────────────────────────────────────────────────

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose: (tabId: string) => void;
  onContextMenu: (e: React.MouseEvent, tab: Tab) => void;
  onDoubleClick: () => void;
  onDragStart: (tabId: string) => void;
  onDragOver: (tabId: string) => void;
  onDragEnd: () => void;
  isDragTarget: boolean;
}

function TabItem({
  tab, isActive, onActivate, onClose, onContextMenu, onDoubleClick,
  onDragStart, onDragOver, onDragEnd, isDragTarget,
}: TabItemProps) {
  const [hovered, setHovered] = useState(false);
  const fileName = getFileName(tab.filePath);
  const ext = getExtension(fileName);
  const iconColor = getFileIconColor(ext);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose(tab.id);
  }, [tab.id, onClose]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.id);
    onDragStart(tab.id);
  }, [tab.id, onDragStart]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOver(tab.id);
  }, [tab.id, onDragOver]);

  const base = `group relative flex items-center h-[26px] rounded-md cursor-pointer select-none flex-shrink-0 transition-colors ${
    isActive ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text'
  } ${isDragTarget ? 'ring-1 ring-inset ring-ctp-accent' : ''}`;

  // Pinned tab: show only icon
  if (tab.isPinned) {
    return React.createElement('div', {
      className: `${base} justify-center w-7`,
      onClick: onActivate,
      onContextMenu: (e: React.MouseEvent) => onContextMenu(e, tab),
      onDoubleClick,
      draggable: true,
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragEnd,
      title: tab.filePath,
    },
      React.createElement(FileIconSvg, { color: iconColor }),
      tab.isDirty
        ? React.createElement('div', {
            className: 'absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-ctp-warning',
          })
        : null,
    );
  }

  // Regular tab
  return React.createElement('div', {
    className: `${base} gap-1.5 pl-2.5 pr-1 max-w-[200px] text-xs`,
    onClick: onActivate,
    onContextMenu: (e: React.MouseEvent) => onContextMenu(e, tab),
    onDoubleClick,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    draggable: true,
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragEnd,
    title: tab.filePath,
  },
    React.createElement('span', { className: `truncate ${tab.isPreview ? 'italic' : ''}` }, fileName),
    tab.isDirty
      ? React.createElement('span', {
          className: 'w-1.5 h-1.5 rounded-full bg-ctp-warning flex-shrink-0',
          title: 'Unsaved changes',
        })
      : null,
    // Close button: visible on the active or hovered tab, space kept otherwise
    React.createElement('button', {
      type: 'button',
      className: `w-4 h-4 flex-shrink-0 flex items-center justify-center rounded text-ctp-overlay1 hover:bg-surface-1 hover:text-ctp-text ${
        hovered || isActive ? '' : 'opacity-0'
      }`,
      onClick: handleClose,
      title: 'Close tab',
      'aria-label': `Close ${fileName}`,
    },
      React.createElement('svg', {
        width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        React.createElement('line', { x1: 18, y1: 6, x2: 6, y2: 18 }),
        React.createElement('line', { x1: 6, y1: 6, x2: 18, y2: 18 }),
      ),
    ),
  );
}

// ── TabBar ───────────────────────────────────────────────────────────

interface TabBarProps {
  api: PluginAPI;
  onCloseTab: (tabId: string) => void;
  onRevealInTree: (filePath: string) => void;
  /** The strip's right side: the active file's path, cursor position and menu. */
  trailing?: React.ReactNode;
}

/**
 * Open files as one 32px strip (spec #2023): tabs on the left, the active
 * file's path, cursor position and menu on the right. It replaces the tab
 * bar, the file header and the status bar.
 */
export function TabBar({ api: _api, onCloseTab, onRevealInTree, trailing }: TabBarProps) {
  const [tabs, setTabs] = useState<Tab[]>(fileState.getOrderedTabs());
  const [activeTabId, setActiveTabId] = useState<string | null>(fileState.activeTabId);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [showLeftChevron, setShowLeftChevron] = useState(false);
  const [showRightChevron, setShowRightChevron] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Subscribe to state changes
  useEffect(() => {
    return fileState.subscribe(() => {
      setTabs(fileState.getOrderedTabs());
      setActiveTabId(fileState.activeTabId);
    });
  }, []);

  // Check overflow for chevrons
  const checkOverflow = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setShowLeftChevron(el.scrollLeft > 0);
    setShowRightChevron(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    checkOverflow();
    const el = scrollContainerRef.current;
    if (!el) return;

    el.addEventListener('scroll', checkOverflow);
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);

    return () => {
      el.removeEventListener('scroll', checkOverflow);
      observer.disconnect();
    };
  }, [checkOverflow, tabs]);

  // Scroll active tab into view
  useEffect(() => {
    if (!activeTabId || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current;
    const tabEl = el.querySelector(`[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
    if (tabEl && tabEl.scrollIntoView) {
      tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activeTabId]);

  const scrollLeft = useCallback(() => {
    scrollContainerRef.current?.scrollBy({ left: -150, behavior: 'smooth' });
  }, []);

  const scrollRight = useCallback(() => {
    scrollContainerRef.current?.scrollBy({ left: 150, behavior: 'smooth' });
  }, []);

  // Tab actions
  const handleActivate = useCallback((tabId: string) => {
    fileState.activateTab(tabId);
  }, []);

  const handleDoubleClick = useCallback((tabId: string) => {
    fileState.promotePreview(tabId);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tab });
  }, []);

  const contextItems = useCallback((tab: Tab): MenuItem[] => [
    { id: 'close', label: 'Close', onSelect: () => onCloseTab(tab.id) },
    { id: 'close-others', label: 'Close others', onSelect: () => fileState.closeOtherTabs(tab.id) },
    { id: 'close-right', label: 'Close to the right', onSelect: () => fileState.closeTabsToRight(tab.id) },
    { id: 'close-all', label: 'Close all', onSelect: () => fileState.closeAllTabs() },
    {
      id: 'pin',
      label: tab.isPinned ? 'Unpin' : 'Pin',
      onSelect: () => (tab.isPinned ? fileState.unpinTab(tab.id) : fileState.pinTab(tab.id)),
    },
    { id: 'copy-path', label: 'Copy path', onSelect: () => { navigator.clipboard.writeText(tab.filePath).catch(() => {}); } },
    { id: 'reveal', label: 'Reveal in file tree', onSelect: () => onRevealInTree(tab.filePath) },
  ], [onCloseTab, onRevealInTree]);

  // Drag handlers
  const handleDragStart = useCallback((tabId: string) => {
    setDragSourceId(tabId);
  }, []);

  const handleDragOver = useCallback((tabId: string) => {
    if (tabId !== dragSourceId) {
      setDragOverTabId(tabId);
    }
  }, [dragSourceId]);

  const handleDragEnd = useCallback(() => {
    if (dragSourceId && dragOverTabId) {
      const newIndex = fileState.tabOrder.indexOf(dragOverTabId);
      if (newIndex >= 0) {
        fileState.reorderTab(dragSourceId, newIndex);
      }
    }
    setDragSourceId(null);
    setDragOverTabId(null);
  }, [dragSourceId, dragOverTabId]);

  if (tabs.length === 0) return null;

  const chevron = (onClick: () => void, icon: React.ReactElement, label: string) =>
    React.createElement('button', {
      type: 'button',
      className: 'flex-shrink-0 w-6 h-7 flex items-center justify-center rounded-md text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-0 transition-colors',
      onClick,
      'aria-label': label,
    }, icon);

  return React.createElement('div', {
    className: 'h-8 flex items-center gap-1 pl-1.5 pr-2 border-b border-surface-0 flex-shrink-0 min-w-0',
    'data-testid': 'files-tab-strip',
  },
    showLeftChevron ? chevron(scrollLeft, ChevronLeftIcon, 'Scroll tabs left') : null,

    // Scrollable tab container
    React.createElement('div', {
      ref: scrollContainerRef,
      className: 'flex items-center gap-0.5 min-w-0 overflow-x-auto scrollbar-none',
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
    },
      ...tabs.map((tab) =>
        React.createElement('div', {
          key: tab.id,
          'data-tab-id': tab.id,
        },
          React.createElement(TabItem, {
            tab,
            isActive: tab.id === activeTabId,
            onActivate: () => handleActivate(tab.id),
            onClose: onCloseTab,
            onContextMenu: handleContextMenu,
            onDoubleClick: () => handleDoubleClick(tab.id),
            onDragStart: handleDragStart,
            onDragOver: handleDragOver,
            onDragEnd: handleDragEnd,
            isDragTarget: tab.id === dragOverTabId,
          }),
        ),
      ),
    ),

    showRightChevron ? chevron(scrollRight, ChevronRightIcon, 'Scroll tabs right') : null,

    trailing
      ? React.createElement('div', { className: 'ml-auto pl-2 flex items-center gap-1.5 min-w-0 flex-shrink text-xs text-ctp-overlay1' }, trailing)
      : null,

    contextMenu
      ? React.createElement(PopupMenu, {
          items: contextItems(contextMenu.tab),
          position: { x: contextMenu.x, y: contextMenu.y },
          label: 'Tab actions',
          testId: 'files-tab-menu',
          onClose: () => setContextMenu(null),
        })
      : null,
  );
}
