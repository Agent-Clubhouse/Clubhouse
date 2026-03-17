import React, { useEffect, useMemo, useState, useCallback } from 'react';
import type { PluginContext, PluginAPI, PluginModule, AgentInfo } from '../../../../shared/plugin-types';
import { createLoungeStore, groupAgentsByCategory, disambiguateAgentName } from './state';
import type { LoungeCategory } from './state';

const useLoungeStore = createLoungeStore();

export function activate(ctx: PluginContext, _api: PluginAPI): void {
  // No commands to register yet — reserved for future keybindings
  void ctx;
}

export function deactivate(): void {
  // subscriptions auto-disposed
}

// ── Status helpers ─────────────────────────────────────────────────────

function statusColor(status: AgentInfo['status']): string {
  switch (status) {
    case 'running': return 'bg-ctp-green';
    case 'sleeping': return 'bg-ctp-yellow';
    case 'error': return 'bg-ctp-red';
    case 'creating': return 'bg-ctp-blue';
    default: return 'bg-ctp-overlay0';
  }
}

function statusLabel(status: AgentInfo['status']): string {
  switch (status) {
    case 'running': return 'Running';
    case 'sleeping': return 'Sleeping';
    case 'error': return 'Error';
    case 'creating': return 'Creating';
    default: return status;
  }
}

// ── Agent Row ──────────────────────────────────────────────────────────

function AgentRow({ agent, displayName, isSelected, onClick }: {
  agent: AgentInfo;
  displayName: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  return React.createElement('button', {
    key: agent.id,
    onClick,
    title: `${displayName} — ${statusLabel(agent.status)}`,
    'data-testid': `lounge-agent-${agent.id}`,
    className: `w-full text-left px-3 py-2 text-sm cursor-pointer transition-colors flex items-center gap-3 ${
      isSelected
        ? 'bg-surface-1 text-ctp-text'
        : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
    }`,
  },
    React.createElement('span', {
      className: `w-2 h-2 rounded-full flex-shrink-0 ${statusColor(agent.status)}`,
    }),
    React.createElement('span', { className: 'truncate flex-1' }, displayName),
    agent.status === 'running' && React.createElement('span', {
      className: 'text-[10px] text-ctp-green flex-shrink-0',
    }, '●'),
  );
}

// ── Category Section ───────────────────────────────────────────────────

const CHEVRON_RIGHT = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '9 18 15 12 9 6' }));

const CHEVRON_DOWN = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '6 9 12 15 18 9' }));

function CategorySection({ category, agents, allAgents, projects, isCollapsed, selectedAgentId, onToggle, onSelectAgent }: {
  category: LoungeCategory;
  agents: AgentInfo[];
  allAgents: AgentInfo[];
  projects: { id: string; name: string; path: string }[];
  isCollapsed: boolean;
  selectedAgentId: string | null;
  onToggle: () => void;
  onSelectAgent: (agentId: string, projectId: string) => void;
}) {
  return React.createElement('div', {
    'data-testid': `lounge-category-${category.id}`,
  },
    // Category header
    React.createElement('button', {
      onClick: onToggle,
      className: 'w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider hover:bg-surface-0 cursor-pointer transition-colors',
      'data-testid': `lounge-category-toggle-${category.id}`,
    },
      isCollapsed ? CHEVRON_RIGHT : CHEVRON_DOWN,
      React.createElement('span', { className: 'flex-1 text-left truncate' }, category.label),
      React.createElement('span', { className: 'text-[10px] text-ctp-overlay0 tabular-nums' }, String(agents.length)),
    ),
    // Agent rows (hidden when collapsed)
    !isCollapsed && agents.map((agent) => {
      const displayName = disambiguateAgentName(agent, allAgents, projects);
      return React.createElement(AgentRow, {
        key: agent.id,
        agent,
        displayName,
        isSelected: selectedAgentId === agent.id,
        onClick: () => onSelectAgent(agent.id, agent.projectId),
      });
    }),
  );
}

// ── Empty State ────────────────────────────────────────────────────────

function EmptyState() {
  return React.createElement('div', {
    className: 'flex items-center justify-center h-full text-center px-6',
  },
    React.createElement('div', null,
      React.createElement('p', { className: 'text-ctp-subtext0 text-sm mb-1' }, 'No agents yet'),
      React.createElement('p', { className: 'text-ctp-overlay0 text-xs' }, 'Agents will appear here grouped by project.'),
    ),
  );
}

// ── Agent Content ──────────────────────────────────────────────────────

function AgentContent({ api, agentId }: { api: PluginAPI; agentId: string }) {
  const agents = api.agents.list();
  const agent = agents.find((a) => a.id === agentId);

  if (!agent) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-sm',
    }, 'Agent not found');
  }

  const { AgentTerminal, SleepingAgent } = api.widgets;

  if (agent.status === 'sleeping' || agent.status === 'error') {
    return React.createElement(SleepingAgent, { agentId: agent.id });
  }

  return React.createElement(AgentTerminal, { agentId: agent.id, focused: true });
}

// ── No Selection Placeholder ───────────────────────────────────────────

function NoSelection() {
  return React.createElement('div', {
    className: 'flex items-center justify-center h-full text-center px-6',
    'data-testid': 'lounge-no-selection',
  },
    React.createElement('div', null,
      React.createElement('p', { className: 'text-ctp-subtext0 text-sm mb-1' }, 'Select an agent'),
      React.createElement('p', { className: 'text-ctp-overlay0 text-xs' }, 'Click an agent from the list to view it here.'),
    ),
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const categories = useLoungeStore((s) => s.categories);
  const collapsed = useLoungeStore((s) => s.collapsed);
  const selectedAgentId = useLoungeStore((s) => s.selectedAgentId);
  const deriveCategories = useLoungeStore((s) => s.deriveCategories);
  const toggleCollapsed = useLoungeStore((s) => s.toggleCollapsed);
  const selectAgent = useLoungeStore((s) => s.selectAgent);

  // Force re-render when agents change
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api]);

  // Derive categories from projects
  const projects = useMemo(() => api.projects.list(), [api, agentTick]);
  useEffect(() => {
    deriveCategories(projects);
  }, [projects, deriveCategories]);

  // Get all agents across projects
  const agents = useMemo(() => api.agents.list(), [api, agentTick]);

  // Group agents by category
  const grouped = useMemo(
    () => groupAgentsByCategory(agents, categories),
    [agents, categories],
  );

  const handleSelectAgent = useCallback((agentId: string, projectId: string) => {
    selectAgent(agentId, projectId);
    api.navigation.focusAgent(agentId);
  }, [api, selectAgent]);

  // Clear selection when agent disappears
  useEffect(() => {
    if (selectedAgentId && !agents.find((a) => a.id === selectedAgentId)) {
      selectAgent(null);
    }
  }, [agents, selectedAgentId, selectAgent]);

  const hasAgents = agents.length > 0;

  return React.createElement('div', {
    className: 'flex h-full w-full bg-ctp-base',
    'data-testid': 'lounge-main-panel',
  },
    // Left sidebar — agent list
    React.createElement('div', {
      className: 'w-64 flex-shrink-0 flex flex-col bg-ctp-mantle border-r border-surface-0 h-full min-h-0',
    },
      // Header
      React.createElement('div', {
        className: 'px-3 py-3 border-b border-surface-0',
      },
        React.createElement('h2', {
          className: 'text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider',
        }, 'Lounge'),
      ),
      // Scrollable category list
      React.createElement('div', {
        className: 'flex-1 overflow-y-auto py-1',
        'data-testid': 'lounge-category-list',
      },
        hasAgents
          ? categories.map((cat) => {
              const catAgents = grouped.get(cat.id) ?? [];
              if (catAgents.length === 0) return null;
              return React.createElement(CategorySection, {
                key: cat.id,
                category: cat,
                agents: catAgents,
                allAgents: agents,
                projects,
                isCollapsed: collapsed.has(cat.id),
                selectedAgentId,
                onToggle: () => toggleCollapsed(cat.id),
                onSelectAgent: handleSelectAgent,
              });
            })
          : React.createElement(EmptyState),
      ),
    ),
    // Right content — selected agent view
    React.createElement('div', {
      className: 'flex-1 min-w-0 h-full',
    },
      selectedAgentId
        ? React.createElement(AgentContent, { api, agentId: selectedAgentId })
        : React.createElement(NoSelection),
    ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
