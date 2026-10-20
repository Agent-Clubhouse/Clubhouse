import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useChromeStore } from '../chromeStore';
import { processResumeQueue } from '../../services/resume-queue';
import { ProjectTree, type ProjectTreeProps } from './ProjectTree';
import type { DurableAgentConfig, Project, RestartSessionEntry } from '../../../shared/types';

// An update restart resumes a lead and its two helpers (#2410). The sidebar
// nests by the in-memory parentAgentId, so the resume has to keep it.

const PROJECT_PATH = '/src/a';
const project = { id: 'a', name: 'A', path: PROJECT_PATH } as Project;

const configs: DurableAgentConfig[] = [
  { id: 'lead', name: 'lead', color: 'blue', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'h1', name: 'h1', color: 'blue', createdAt: '2026-01-01T00:00:00.000Z', parentAgentId: 'lead' },
  { id: 'h2', name: 'h2', color: 'blue', createdAt: '2026-01-01T00:00:00.000Z', parentAgentId: 'lead' },
] as DurableAgentConfig[];

const entry = (agentId: string): RestartSessionEntry => ({
  agentId,
  agentName: agentId,
  projectPath: PROJECT_PATH,
  orchestrator: 'claude-code',
  sessionId: `s-${agentId}`,
  resumeStrategy: 'auto',
  kind: 'durable',
});

const order = () => [...document.querySelectorAll('[data-agent-id]')].map((el) => el.getAttribute('data-agent-id'));
const parentOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-tree-key="agent:${id}"]`)?.dataset.treeParent;

function renderSidebar() {
  const agents = Object.values(useAgentStore.getState().agents);
  const props: ProjectTreeProps = {
    projects: [project],
    projectIcons: {},
    agentsByProject: { a: agents },
    detailed: {},
    completedByProject: {},
    activeProjectId: 'a',
    activeAgentId: null,
    projectScopeId: null,
    selectedCompletedId: null,
    onReorder: vi.fn(),
    onSelectProject: vi.fn(),
    onNewAgent: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectCompleted: vi.fn(),
    onDismissCompleted: vi.fn(),
    onClearCompleted: vi.fn(),
    onOpenSettings: vi.fn(),
    onReorderAgents: vi.fn(),
  };
  render(<ProjectTree {...props} />);
}

function expectNested() {
  expect(order()).toEqual(['lead', 'h1', 'h2']);
  expect(parentOf('h1')).toBe('agent:lead');
  expect(parentOf('h2')).toBe('agent:lead');
}

async function resumeAll() {
  await processResumeQueue({
    version: 1,
    capturedAt: new Date().toISOString(),
    appVersion: '0.42.0',
    sessions: configs.map((c) => entry(c.id)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({ agents: {}, agentSpawnedAt: {} });
  useProjectStore.setState({ projects: [project] });
  useChromeStore.setState({
    pinnedProjectIds: [], collapsedProjectIds: [], collapsedAgentIds: [], expandedFolds: [],
    projectActivity: { a: Date.now() }, idleDays: 7, idleOpen: false,
  });
  Object.assign(window, {
    clubhouse: {
      ...(window as any).clubhouse,
      agent: {
        listDurable: vi.fn().mockResolvedValue(configs),
        getRunningStatuses: vi.fn().mockResolvedValue([]),
        getBackupInfo: vi.fn().mockResolvedValue(null),
        getDurableConfig: vi.fn((_path: string, id: string) => Promise.resolve(configs.find((c) => c.id === id) ?? null)),
        spawnAgent: vi.fn().mockResolvedValue(undefined),
        readIcon: vi.fn().mockResolvedValue(null),
      },
      pty: { kill: vi.fn() },
    },
  });
});

describe('ProjectTree helpers after an update restart resumes them (#2410)', () => {
  it('stay nested when loadDurableAgents ran before the resume', async () => {
    await useAgentStore.getState().loadDurableAgents('a', PROJECT_PATH);
    await resumeAll();
    expect(useAgentStore.getState().agents.h1.parentAgentId).toBe('lead');
    renderSidebar();
    expectNested();
  });

  it('stay nested when the resume runs before loadDurableAgents', async () => {
    await resumeAll();
    expect(useAgentStore.getState().agents.h2.parentAgentId).toBe('lead');
    renderSidebar();
    expectNested();
  });

  it('stay nested when a resumed helper is then put to sleep', async () => {
    await useAgentStore.getState().loadDurableAgents('a', PROJECT_PATH);
    await resumeAll();
    useAgentStore.getState().updateAgentStatus('h1', 'sleeping', 0);
    expect(useAgentStore.getState().agents.h1.parentAgentId).toBe('lead');
    renderSidebar();
    expectNested();
  });
});
