import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import { fileState } from './state';
import type { Tab } from './state';
import { getFileIconColor } from './file-icons';

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
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '15 18 9 12 15 6' }));

const ChevronRightIcon = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '9 6 15 12 9 18' }));

// ── Tab Context Menu ─────────────────────────────────────────────────

interface TabContextMenuProps {
  x: number;
  y: number;
  tab: Tab;
  onClose: () => void;
  onAction: (action: string) => void;
}

function TabContextMenu({ x, y, tab, onClose, onAction }: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const items = [
    { label: 'Close', action: 'close' },
    { label: 'Close Others', action: 'closeOthers' },
    { label: 'Close All', action: 'closeAll' },
    { label: 'Close to the Right', action: 'closeToRight' },
    { label: '—', action: 'separator1' },
    { label: tab.isPinned ? 'Unpin' : 'Pin', action: 'togglePin' },
    { label: '—', action: 'separator2' },
    { label: 'Copy Path', action: 'copyPath' },
    { label: 'Reveal in File Tree', action: 'revealInTree' },
  ];

  const style = useMemo(() => {
    const menuWidth = 170;
    const menuHeight = items.length * 22 + 8; // estimated height per item + padding
    return {
      left: Math.min(x, window.innerWidth - menuWidth - 8),
      top: Math.min(y, window.innerHeight - menuHeight - 8),
    };
  }, [x, y, items.length]);

  return React.createElement('div', {
    ref: menuRef,
    className: 'fixed z-50 bg-ctp-mantle border border-ctp-surface0 rounded shadow-lg py-1 min-w-[170px]',
    style,
  },
    ...items.map((item) => {
      if (item.label === '—') {
        return React.createElement('div', {
          key: item.action,
          className: 'border-t border-ctp-surface0 my-1',
        });
      }
      return React.createElement('button', {
        key: item.action,
        className: 'w-full text-left px-3 py-1 text-xs text-ctp-text hover:bg-ctp-surface0 transition-colors',
        onClick: () => { onAction(item.action); onClose(); },
      }, item.label);
    }),
  );
}

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

  // Pinned tab: show only icon
  if (tab.isPinned) {
    return React.createElement('div', {
      className: `
        group relative flex items-center justify-center px-2 py-1 cursor-pointer select-none
        transition-colors duration-100 flex-shrink-0 border-b-2
        ${isActive
          ? 'bg-ctp-base border-ctp-accent'
          : 'bg-ctp-mantle border-transparent hover:bg-ctp-surface0'
        }
        ${isDragTarget ? 'border-l-2 border-l-ctp-accent' : ''}
      `.trim(),
      style: { minWidth: 32, height: 35 },
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
            className: 'absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-ctp-peach',
          })
        : null,
    );
  }

  // Regular tab
  return React.createElement('div', {
    className: `
      group relative flex items-center gap-1.5 px-2.5 py-1 cursor-pointer select-none
      transition-colors duration-100 flex-shrink-0 border-b-2
      ${isActive
        ? 'bg-ctp-base border-ctp-accent'
        : 'bg-ctp-mantle border-transparent hover:bg-ctp-surface0'
      }
      ${isDragTarget ? 'border-l-2 border-l-ctp-accent' : ''}
    `.trim(),
    style: { minWidth: 100, maxWidth: 200, height: 35 },
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
    React.createElement(FileIconSvg, { color: iconColor }),
    React.createElement('span', {
      className: `text-[11px] truncate ${tab.isPreview ? 'italic' : ''} ${isActive ? 'text-ctp-text' : 'text-ctp-subtext0'}`,
    }, fileName),
    // Dirty dot / Close button area
    React.createElement('div', {
      className: 'flex-shrink-0 w-4 h-4 flex items-center justify-center ml-auto',
    },
      // Show close button on hover, dirty dot otherwise
      (hovered || isActive)
        ? React.createElement('button', {
            className: `w-4 h-4 flex items-center justify-center rounded text-[10px]
              ${tab.isDirty
                ? 'text-ctp-peach hover:bg-ctp-surface1'
                : 'text-ctp-overlay0 hover:bg-ctp-surface1 hover:text-ctp-text'
              }`,
            onClick: handleClose,
            title: 'Close tab',
          }, '\u00D7')
        : tab.isDirty
          ? React.createElement('span', {
              className: 'w-2 h-2 rounded-full bg-ctp-peach',
            })
          : null,
    ),
  );
}

// ── TabBar ───────────────────────────────────────────────────────────

interface TabBarProps {
  api: PluginAPI;
  onCloseTab: (tabId: string) => void;
  onRevealInTree: (filePath: string) => void;
}

export function TabBar({ api: _api, onCloseTab, onRevealInTree }: TabBarProps) {
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

  const handleContextAction = useCallback((action: string) => {
    if (!contextMenu) return;
    const { tab } = contextMenu;

    switch (action) {
      case 'close':
        onCloseTab(tab.id);
        break;
      case 'closeOthers':
        fileState.closeOtherTabs(tab.id);
        break;
      case 'closeAll':
        fileState.closeAllTabs();
        break;
      case 'closeToRight':
        fileState.closeTabsToRight(tab.id);
        break;
      case 'togglePin':
        if (tab.isPinned) {
          fileState.unpinTab(tab.id);
        } else {
          fileState.pinTab(tab.id);
        }
        break;
      case 'copyPath':
        navigator.clipboard.writeText(tab.filePath).catch(() => {});
        break;
      case 'revealInTree':
        onRevealInTree(tab.filePath);
        break;
    }
  }, [contextMenu, onCloseTab, onRevealInTree]);

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

  return React.createElement('div', {
    className: 'flex items-center bg-ctp-mantle border-b border-ctp-surface0 flex-shrink-0',
    style: { height: 35 },
  },
    // Left chevron
    showLeftChevron
      ? React.createElement('button', {
          className: 'flex-shrink-0 w-5 h-full flex items-center justify-center text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 transition-colors',
          onClick: scrollLeft,
        }, ChevronLeftIcon)
      : null,

    // Scrollable tab container
    React.createElement('div', {
      ref: scrollContainerRef,
      className: 'flex items-center flex-1 overflow-x-auto scrollbar-none',
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

    // Right chevron
    showRightChevron
      ? React.createElement('button', {
          className: 'flex-shrink-0 w-5 h-full flex items-center justify-center text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 transition-colors',
          onClick: scrollRight,
        }, ChevronRightIcon)
      : null,

    // Context menu
    contextMenu
      ? React.createElement(TabContextMenu, {
          x: contextMenu.x,
          y: contextMenu.y,
          tab: contextMenu.tab,
          onClose: () => setContextMenu(null),
          onAction: handleContextAction,
        })
      : null,
  );
}
