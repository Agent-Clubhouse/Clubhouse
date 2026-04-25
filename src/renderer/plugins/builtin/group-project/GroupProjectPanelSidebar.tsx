import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ResizeDivider } from '../../../components/ResizeDivider';

/* ---------- Constants ---------- */

export const PANEL_RAIL_WIDTH = 28;

export const TOPICS_DEFAULT_WIDTH = 144;
export const TOPICS_MIN_WIDTH = 80;
export const TOPICS_MAX_WIDTH = 280;

export const MESSAGES_DEFAULT_WIDTH = 192;
export const MESSAGES_MIN_WIDTH = 100;
export const MESSAGES_MAX_WIDTH = 400;

const PANEL_STORAGE_KEY = 'clubhouse_group_project_panel_layout';

/* ---------- Layout State ---------- */

interface GroupProjectPanelLayoutState {
  topicsWidth: number;
  topicsCollapsed: boolean;
  messagesWidth: number;
  messagesCollapsed: boolean;
}

const DEFAULT_LAYOUT: GroupProjectPanelLayoutState = {
  topicsWidth: TOPICS_DEFAULT_WIDTH,
  topicsCollapsed: false,
  messagesWidth: MESSAGES_DEFAULT_WIDTH,
  messagesCollapsed: false,
};

export function loadPanelLayout(): GroupProjectPanelLayoutState {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GroupProjectPanelLayoutState>;
      return {
        topicsWidth: parsed.topicsWidth ?? TOPICS_DEFAULT_WIDTH,
        topicsCollapsed: parsed.topicsCollapsed ?? false,
        messagesWidth: parsed.messagesWidth ?? MESSAGES_DEFAULT_WIDTH,
        messagesCollapsed: parsed.messagesCollapsed ?? false,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_LAYOUT };
}

export function savePanelLayout(layout: GroupProjectPanelLayoutState): void {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(layout));
  } catch { /* ignore */ }
}

/* ---------- Hook ---------- */

export function useGroupProjectPanelLayout() {
  const [layout, setLayout] = useState<GroupProjectPanelLayoutState>(loadPanelLayout);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => savePanelLayout(layout), 300);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [layout]);

  const resizeTopics = useCallback((delta: number) => {
    setLayout((l) => ({
      ...l,
      topicsWidth: Math.min(TOPICS_MAX_WIDTH, Math.max(TOPICS_MIN_WIDTH, l.topicsWidth + delta)),
    }));
  }, []);

  const toggleTopicsCollapse = useCallback(() => {
    setLayout((l) => ({ ...l, topicsCollapsed: !l.topicsCollapsed }));
  }, []);

  const resizeMessages = useCallback((delta: number) => {
    setLayout((l) => ({
      ...l,
      messagesWidth: Math.min(MESSAGES_MAX_WIDTH, Math.max(MESSAGES_MIN_WIDTH, l.messagesWidth + delta)),
    }));
  }, []);

  const toggleMessagesCollapse = useCallback(() => {
    setLayout((l) => ({ ...l, messagesCollapsed: !l.messagesCollapsed }));
  }, []);

  return {
    ...layout,
    resizeTopics,
    toggleTopicsCollapse,
    resizeMessages,
    toggleMessagesCollapse,
  };
}

/* ---------- Component ---------- */

interface GroupProjectPanelSidebarProps {
  width: number;
  collapsed: boolean;
  onResize: (delta: number) => void;
  onToggleCollapse: () => void;
  children: React.ReactNode;
}

/**
 * A controlled resizable+collapsible sidebar panel for the group project expanded view.
 * When collapsed, shows a narrow rail that reveals a floating overlay on hover.
 */
export function GroupProjectPanelSidebar({
  width,
  collapsed,
  onResize,
  onToggleCollapse,
  children,
}: GroupProjectPanelSidebarProps) {
  const [hovered, setHovered] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHovered(true);
  }, []);

  const handleLeave = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => setHovered(false), 150);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  if (collapsed) {
    return (
      <div
        className="relative flex-shrink-0"
        style={{ width: PANEL_RAIL_WIDTH }}
        data-testid="group-project-panel-rail"
      >
        {/* Collapsed rail strip */}
        <div
          className="h-full border-r border-surface-1 bg-ctp-mantle/30 flex items-center justify-center cursor-pointer"
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          onClick={onToggleCollapse}
          title="Expand panel"
          data-testid="panel-rail-toggle"
        >
          <span className="text-[8px] text-ctp-subtext0 select-none" data-testid="panel-rail-icon">
            &#x25B6;
          </span>
        </div>

        {/* Hover overlay — floats over the content area */}
        {hovered && (
          <div
            className="absolute top-0 left-0 z-10 h-full shadow-xl border-r border-surface-1 bg-ctp-mantle overflow-y-auto"
            style={{ width }}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
            data-testid="panel-rail-overlay"
          >
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className="flex-shrink-0 overflow-y-auto"
        style={{ width }}
        data-testid="group-project-panel-sidebar"
      >
        {children}
      </div>
      <ResizeDivider
        onResize={onResize}
        onToggleCollapse={onToggleCollapse}
        collapsed={false}
        collapseDirection="left"
      />
    </>
  );
}
