import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../hooks/useModelOptions', () => ({
  useModelOptions: () => ({ options: [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }], loading: false }),
}));

import { ProjectStartPage } from './ProjectStartPage';
import { useAgentStore } from '../../stores/agentStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useUIStore } from '../../stores/uiStore';
import { useChromeStore } from '../chromeStore';
import type { Project } from '../../../shared/types';

const project = { id: 'p1', name: 'Clubhouse', path: '/tmp/ch' } as Project;
let spawnQuickAgent: ReturnType<typeof vi.fn>;
let spawnDurableAgent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  spawnQuickAgent = vi.fn().mockResolvedValue('q-new');
  spawnDurableAgent = vi.fn().mockResolvedValue('a2');
  useAgentStore.setState({
    agents: {
      a1: { id: 'a1', projectId: 'p1', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'blue' },
      a2: { id: 'a2', projectId: 'p1', name: 'sleepy-owl', kind: 'durable', status: 'sleeping', color: 'green' },
      b1: { id: 'b1', projectId: 'p2', name: 'other-owl', kind: 'durable', status: 'sleeping', color: 'green' },
    } as never,
    spawnQuickAgent,
    spawnDurableAgent,
  } as never);
  useOrchestratorStore.setState({ allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code' }] as never, enabled: ['claude-code'] });
  useQuickAgentStore.setState({
    completedAgents: {
      p1: [
        { id: 'q1', projectId: 'p1', name: 'fix-flaky', mission: 'Fix the flaky test', summary: 'Deflaked it', filesModified: ['a.ts'], exitCode: 0, completedAt: Date.now() - 5 * 60_000 },
        { id: 'q2', projectId: 'p1', name: 'triage', mission: 'Triage issues', summary: null, filesModified: [], exitCode: 1, completedAt: Date.now() },
      ],
    },
    selectedCompletedId: null,
  });
  useChromeStore.setState({ projectScopeId: 'p1', composerRequest: 0 });
  useUIStore.setState({ explorerTab: 'agents' });
});

const type = (text: string) => fireEvent.change(screen.getByTestId('start-page-prompt'), { target: { value: text } });

describe('ProjectStartPage', () => {
  it('starts a quick agent at the project root and makes it the selection', async () => {
    render(<ProjectStartPage project={project} />);
    expect(screen.getByTestId('start-page')).toBeTruthy();
    expect((screen.getByTestId('start-page-start') as HTMLButtonElement).disabled).toBe(true);
    type('Fix the build');
    fireEvent.click(screen.getByTestId('start-page-start'));
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalledWith('p1', '/tmp/ch', 'Fix the build', 'default', undefined, 'claude-code'));
    await waitFor(() => expect(useChromeStore.getState().projectScopeId).toBeNull());
  });

  it('submits with Cmd+Enter', async () => {
    render(<ProjectStartPage project={project} />);
    type('Fix the build');
    fireEvent.keyDown(screen.getByTestId('start-page-prompt'), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalled());
  });

  it('wakes a sleeping durable agent of this project with the prompt', async () => {
    const config = { id: 'a2', name: 'sleepy-owl', color: 'green', worktreePath: '/tmp/ch/.clubhouse/agents/sleepy-owl' };
    vi.spyOn(window.clubhouse.agent, 'listDurable').mockResolvedValue([config] as never);
    render(<ProjectStartPage project={project} />);
    const runAs = screen.getByTestId('start-page-run-as') as HTMLSelectElement;
    expect([...runAs.options].map((o) => o.textContent)).toEqual(['New quick agent', 'sleepy-owl']);
    fireEvent.change(runAs, { target: { value: 'a2' } });
    type('Pick up the review');
    expect(screen.getByTestId('start-page-start').textContent).toBe('Wake');
    fireEvent.click(screen.getByTestId('start-page-start'));
    await waitFor(() => expect(spawnDurableAgent).toHaveBeenCalledWith('p1', '/tmp/ch', config, false, 'Pick up the review'));
    expect(spawnQuickAgent).not.toHaveBeenCalled();
  });

  it('keeps the prompt and the selection when starting fails', async () => {
    spawnQuickAgent.mockRejectedValueOnce(new Error('boom'));
    render(<ProjectStartPage project={project} />);
    type('Fix the build');
    fireEvent.click(screen.getByTestId('start-page-start'));
    await waitFor(() => expect((screen.getByTestId('start-page-start') as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByTestId('start-page-prompt') as HTMLTextAreaElement).value).toBe('Fix the build');
    expect(useChromeStore.getState().projectScopeId).toBe('p1');
  });

  it('lists finished quick agents to open, dismiss or clear', () => {
    render(<ProjectStartPage project={project} />);
    expect(screen.getByTestId('start-page-finished').textContent).toContain('Finished, waiting on you');
    expect(screen.getByTestId('start-page-finished-q1').textContent).toContain('Deflaked it');
    expect(screen.getByTestId('start-page-finished-q2').textContent).toContain('Exited with code 1');

    fireEvent.click(screen.getByTestId('start-page-finished-q1'));
    expect(useQuickAgentStore.getState().selectedCompletedId).toBe('q1');
    expect(useChromeStore.getState().projectScopeId).toBeNull();

    fireEvent.click(screen.getByLabelText('Dismiss triage'));
    expect(useQuickAgentStore.getState().completedAgents.p1.map((c) => c.id)).toEqual(['q1']);
    fireEvent.click(screen.getByText('Clear all'));
    expect(screen.queryByTestId('start-page-finished')).toBeNull();
  });

  it('links to the project settings', () => {
    render(<ProjectStartPage project={project} />);
    fireEvent.click(screen.getByTestId('start-page-settings'));
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: 'p1', settingsSubPage: 'project' });
  });
});
