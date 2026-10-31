import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent, DurableAgentConfig } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { HelperHeader } from './HelperHeader';

const PROJECT = path.join('/work', 'proj');
const OTHER = path.join('/work', 'annex');
const lead: Agent = { id: 'lead', projectId: 'p1', name: 'epic-lead', kind: 'durable', status: 'running', color: 'teal' };
const helper: Agent = { id: 'h1', projectId: 'p1', name: 'impl-ipc', kind: 'durable', status: 'running', color: 'teal' };

let configs: Record<string, Partial<DurableAgentConfig>>;

beforeEach(() => {
  configs = { h1: { id: 'h1', name: 'impl-ipc', parentAgentId: 'lead', disposable: true }, lead: { id: 'lead', name: 'epic-lead' } };
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: PROJECT }], activeProjectId: 'p1' } as never);
  useAgentStore.setState({ agents: { lead, h1: helper }, activeAgentId: 'h1' } as never);
  window.clubhouse.agent.getDurableConfig = vi.fn(async (_p: string, id: string) => configs[id] ?? null) as never;
});

afterEach(() => {
  useAgentStore.setState({ agents: {} } as never);
  useProjectStore.setState({ projects: [] });
});

describe('Helper header (#2232)', () => {
  it('names the orchestrator with a link to it and notes a disposable helper', async () => {
    render(<HelperHeader agent={helper} />);
    const header = await screen.findByTestId('helper-header');
    expect(header).toHaveTextContent('Helper of');
    expect(screen.getByTestId('helper-header-parent')).toHaveTextContent('epic-lead');
    expect(screen.getByTestId('helper-header-disposable')).toHaveTextContent('epic-lead may dispose of it when the work is done');
    expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalledWith(PROJECT, 'h1');

    fireEvent.click(screen.getByTestId('helper-header-parent'));
    expect(useAgentStore.getState().activeAgentId).toBe('lead');
  });

  it('leaves out the note for a helper that isn\'t disposable', async () => {
    configs.h1 = { ...configs.h1, disposable: false };
    render(<HelperHeader agent={helper} />);
    await screen.findByTestId('helper-header');
    expect(screen.queryByTestId('helper-header-disposable')).not.toBeInTheDocument();
  });

  it('renders nothing for a top-level agent', async () => {
    render(<HelperHeader agent={lead} />);
    await waitFor(() => expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalledWith(PROJECT, 'lead'));
    expect(screen.queryByTestId('helper-header')).not.toBeInTheDocument();
  });

  it('names the orchestrator\'s project when it is in another one, and the link switches to it (#2514)', async () => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: PROJECT }, { id: 'p2', name: 'annex', displayName: 'Annex', path: OTHER }] } as never);
    useAgentStore.setState({ agents: { lead: { ...lead, projectId: 'p2' }, h1: helper }, activeAgentId: 'h1' } as never);
    configs.h1 = { ...configs.h1, parentProjectPath: OTHER };
    render(<HelperHeader agent={helper} />);
    expect(await screen.findByTestId('helper-header-parent-project')).toHaveTextContent('in Annex');
    expect(screen.getByTestId('helper-header-parent')).toHaveTextContent('epic-lead');
    fireEvent.click(screen.getByTestId('helper-header-parent'));
    expect(useProjectStore.getState().activeProjectId).toBe('p2');
    expect(useAgentStore.getState().activeAgentId).toBe('lead');
  });

  it('names no project when the orchestrator is in the same one', async () => {
    render(<HelperHeader agent={helper} />);
    await screen.findByTestId('helper-header-parent');
    expect(screen.queryByTestId('helper-header-parent-project')).not.toBeInTheDocument();
  });

  it('uses the rail\'s parent link when it has one (#2231)', async () => {
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => null) as never;
    render(<HelperHeader agent={{ ...helper, parentAgentId: 'lead' }} />);
    expect(await screen.findByTestId('helper-header-parent')).toHaveTextContent('epic-lead');
  });
});
