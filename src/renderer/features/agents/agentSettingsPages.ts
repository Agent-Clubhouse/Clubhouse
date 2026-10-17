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

/** Pages whose text edits wait for the save bar. */
export type AgentSettingsTextPage = 'instructions' | 'permissions' | 'quick';

interface AgentSettingsPagesState {
  page: AgentSettingsPage;
  /** Pages with unsaved text edits, in page order. */
  dirtyPages: AgentSettingsTextPage[];
  /** Items on the list pages, for the sidebar. Missing until loaded. */
  counts: Partial<Record<AgentSettingsPage, number>>;
  shellOpen: boolean;
  setPage: (page: AgentSettingsPage) => void;
  setDirtyPages: (pages: AgentSettingsTextPage[]) => void;
  setCount: (page: AgentSettingsPage, count: number) => void;
  setShellOpen: (open: boolean) => void;
  /** Back to General with nothing dirty, for a newly opened agent. */
  reset: () => void;
}

const INITIAL: Pick<AgentSettingsPagesState, 'page' | 'dirtyPages' | 'counts' | 'shellOpen'> = {
  page: 'general',
  dirtyPages: [],
  counts: {},
  shellOpen: false,
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
  setShellOpen: (shellOpen) => set({ shellOpen }),
  reset: () => set(INITIAL),
}));

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
