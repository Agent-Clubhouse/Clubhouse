import { useEffect, useLayoutEffect, useRef } from 'react';
import { create } from 'zustand';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import type { Agent } from '../../../shared/types';

/**
 * Agent settings as pages (#2015). In the new chrome the sidebar lists these
 * pages, like Settings, and the pane shows the selected one. The classic shell
 * stacks them on one page. The sidebar and the pane share this store.
 */
export type AgentSettingsPage =
  | 'general'
  | 'instructions'
  | 'skills'
  | 'definitions'
  | 'mcp'
  | 'permissions'
  | 'quick';

export const AGENT_SETTINGS_PAGES: ReadonlyArray<{ page: AgentSettingsPage; label: string }> = [
  { page: 'general', label: 'General' },
  { page: 'instructions', label: 'Instructions' },
  { page: 'skills', label: 'Skills' },
  { page: 'definitions', label: 'Agent definitions' },
  { page: 'mcp', label: 'MCP servers' },
  { page: 'permissions', label: 'Permissions' },
  { page: 'quick', label: 'Quick agents' },
];

interface AgentSettingsPagesState {
  page: AgentSettingsPage;
  /** Pages with unsaved edits, in page order. The sidebar marks them. */
  dirtyPages: AgentSettingsPage[];
  /** Items on the list pages, for the sidebar. Missing until loaded. */
  counts: Partial<Record<AgentSettingsPage, number>>;
  shellOpen: boolean;
  /**
   * Someone asked to leave settings while edits were unsaved; the view asks to
   * confirm, then closes settings and runs this (what the user was going to).
   */
  pendingLeave: (() => void) | null;
  setPage: (page: AgentSettingsPage) => void;
  setDirtyPages: (pages: AgentSettingsPage[]) => void;
  setCount: (page: AgentSettingsPage, count: number) => void;
  clearCounts: () => void;
  setShellOpen: (open: boolean) => void;
  setPendingLeave: (then: (() => void) | null) => void;
  /** Back to General with nothing dirty, for a newly opened agent. */
  reset: () => void;
}

const INITIAL: Pick<AgentSettingsPagesState, 'page' | 'dirtyPages' | 'counts' | 'shellOpen' | 'pendingLeave'> = {
  page: 'general',
  dirtyPages: [],
  counts: {},
  shellOpen: false,
  pendingLeave: null,
};

export const useAgentSettingsPages = create<AgentSettingsPagesState>((set, get) => ({
  ...INITIAL,
  setPage: (page) => set({ page }),
  setDirtyPages: (pages) => {
    const prev = get().dirtyPages;
    if (prev.length === pages.length && prev.every((p, i) => p === pages[i])) return;
    set({ dirtyPages: pages });
  },
  setCount: (page, count) => {
    if (get().counts[page] === count) return;
    set((s) => ({ counts: { ...s.counts, [page]: count } }));
  },
  clearCounts: () => {
    if (Object.keys(get().counts).length > 0) set({ counts: {} });
  },
  setShellOpen: (shellOpen) => set({ shellOpen }),
  setPendingLeave: (pendingLeave) => set({ pendingLeave }),
  reset: () => set(INITIAL),
}));

const NOTHING_NEXT = () => {};

/**
 * Leave agent settings and then do `then` (open another agent, say), or ask
 * first when edits are unsaved. With settings closed it just runs `then`.
 * The sidebar's back crumb, Esc, the classic Back button and picking another
 * agent in either sidebar come through here.
 */
export function requestLeaveAgentSettings(then?: () => void): void {
  const settingsOpen = useAgentStore.getState().agentSettingsOpenFor !== null;
  if (settingsOpen && useAgentSettingsPages.getState().dirtyPages.length > 0) {
    useAgentSettingsPages.getState().setPendingLeave(then ?? NOTHING_NEXT);
    return;
  }
  if (settingsOpen) useAgentStore.getState().closeAgentSettings();
  then?.();
}

/** Close agent settings, asking first when edits are unsaved. */
export function requestCloseAgentSettings(): void {
  requestLeaveAgentSettings();
}

/** What a section hands the save bar so the bar can save or discard its edits. */
export interface SaveHandle {
  save: () => Promise<void>;
  discard: () => void;
}

/**
 * For a section that can join the pane's one save bar: registers stable
 * save/discard functions that always call the section's latest ones.
 */
export function useSaveBarSlot(
  register: ((handle: SaveHandle | null) => void) | undefined,
  save: () => Promise<void>,
  discard: () => void,
): void {
  const latest = useRef({ save, discard });
  useLayoutEffect(() => {
    latest.current = { save, discard };
  });
  useEffect(() => {
    if (!register) return;
    register({ save: () => latest.current.save(), discard: () => latest.current.discard() });
    return () => register(null);
  }, [register]);
}

/** Tells the parent whether a section holds unsaved edits, and clears that when it unmounts. */
export function useReportDirty(onDirtyChange: ((dirty: boolean) => void) | undefined, dirty: boolean): void {
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [onDirtyChange, dirty]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
}

/**
 * The agent whose settings fill the pane, or null. Mirrors MainContentView:
 * the Agents tab, settings opened for the active agent, a durable agent in the
 * active project.
 */
export function useAgentSettingsTarget(explorerTab: string): Agent | null {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const agent = useAgentStore((s) =>
    s.agentSettingsOpenFor && s.agentSettingsOpenFor === s.activeAgentId ? s.agents[s.agentSettingsOpenFor] : undefined,
  );
  if (explorerTab !== 'agents' || !agent) return null;
  return agent.kind === 'durable' && agent.projectId === activeProjectId ? agent : null;
}
