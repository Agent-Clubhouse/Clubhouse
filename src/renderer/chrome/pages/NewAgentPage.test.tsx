import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../hooks/useModelOptions', () => ({
  useModelOptions: () => ({ options: [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }], loading: false }),
}));
const createDurableAgent = vi.fn();
vi.mock('../../features/agents/create-agent', () => ({ createDurableAgent: (...args: unknown[]) => createDurableAgent(...args) }));

import { NewAgentPage } from './NewAgentPage';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useUIStore } from '../../stores/uiStore';
import { useChromeStore, type NewAgentRequest } from '../chromeStore';

const projects = [
  { id: 'p1', name: 'Clubhouse', path: '/tmp/ch' },
  { id: 'p2', name: 'Goobers', path: '/tmp/gb' },
];
let spawnQuickAgent: ReturnType<typeof vi.fn>;
const req = (over: Partial<NewAgentRequest> = {}): NewAgentRequest => ({ kind: 'durable', seq: 1, ...over });

beforeEach(() => {
  createDurableAgent.mockReset().mockResolvedValue('a-new');
  spawnQuickAgent = vi.fn().mockResolvedValue('q-new');
  window.clubhouse.project.checkGit = vi.fn().mockResolvedValue(true);
  useProjectStore.setState({ projects: projects as never, activeProjectId: 'p1', projectIcons: {} });
  useAgentStore.setState({
    agents: { a1: { id: 'a1', projectId: 'p2', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'blue', orchestrator: 'claude-code' } } as never,
    spawnQuickAgent,
  } as never);
  useOrchestratorStore.setState({
    allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code', capabilities: { permissions: true } }] as never,
    enabled: ['claude-code'],
    availability: {},
  });
  useUIStore.setState({ explorerTab: 'agents', activeHostId: null });
  useChromeStore.setState({ newAgent: req(), lastProjectId: 'p2', projectActivity: {}, projectScopeId: null });
});

describe('NewAgentPage', () => {
  it('starts on Durable in the selected project, with the worktree switch on', async () => {
    render(<NewAgentPage request={req()} />);
    expect(screen.getByRole('radio', { name: 'Durable' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('new-agent-project').textContent).toContain('Clubhouse');
    expect(screen.getByText('Starts on Clubhouse, selected in the sidebar.')).toBeTruthy();
    expect(screen.getByTestId('new-agent-name')).toHaveFocus();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Own worktree and branch' }).getAttribute('aria-checked')).toBe('true'));
    const name = (screen.getByTestId('new-agent-name') as HTMLInputElement).value;
    expect(screen.getByText(`${name}/standby`)).toBeTruthy();
    expect(screen.getByTestId('new-agent-submit').textContent).toBe('Create');
    expect(screen.queryByRole('textbox', { name: /Mission/ })).toBeNull();
  });

  it('starts on the last project used when none is selected', () => {
    useUIStore.setState({ explorerTab: 'plugin:app:canvas' });
    render(<NewAgentPage request={req()} />);
    expect(screen.getByTestId('new-agent-project').textContent).toContain('Goobers');
    expect(screen.getByText('Starts on Goobers, the last project you used.')).toBeTruthy();
  });

  it('shows the project as plain text when there is only one', () => {
    useProjectStore.setState({ projects: [projects[0]] as never });
    render(<NewAgentPage request={req()} />);
    expect(screen.getByTestId('new-agent-project').tagName).toBe('SPAN');
  });

  it('hides the worktree row in a project without git', async () => {
    window.clubhouse.project.checkGit = vi.fn().mockResolvedValue(false);
    render(<NewAgentPage request={req()} />);
    await waitFor(() => expect(window.clubhouse.project.checkGit).toHaveBeenCalled());
    expect(screen.queryByLabelText('Own worktree and branch')).toBeNull();
  });

  it('creates a durable agent with the form, then opens it', async () => {
    render(<NewAgentPage request={req()} />);
    await waitFor(() => expect(screen.getByLabelText('Own worktree and branch')).toBeTruthy());
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Emerald' }));
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    expect(createDurableAgent).toHaveBeenCalledWith(
      { id: 'p1', path: '/tmp/ch' },
      expect.objectContaining({ name: 'keen-heron', color: 'emerald', useWorktree: true, orchestrator: 'claude-code', model: 'default' }),
    );
    expect(useChromeStore.getState().newAgent).toBeNull();
    await waitFor(() => expect(useAgentStore.getState().activeAgentId).toBe('a-new'));
  });

  it('Quick swaps the durable rows for a required Mission and Runs in', async () => {
    render(<NewAgentPage request={req({ kind: 'quick' })} />);
    const mission = screen.getByTestId('new-agent-mission');
    expect(mission).toHaveFocus();
    expect(screen.queryByTestId('new-agent-name')).toBeNull();
    expect(screen.queryByTestId('new-agent-persona')).toBeNull();
    expect(screen.queryByLabelText('Own worktree and branch')).toBeNull();
    const submit = screen.getByTestId('new-agent-submit') as HTMLButtonElement;
    expect(submit.textContent).toBe('Start');
    expect(submit.disabled).toBe(true);
    fireEvent.change(mission, { target: { value: 'Fix the build' } });
    fireEvent.keyDown(mission, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalledWith('p1', '/tmp/ch', 'Fix the build', 'default', undefined, 'claude-code', undefined));
  });

  it("runs a quick agent in a durable agent's worktree from the picked project", async () => {
    render(<NewAgentPage request={req({ kind: 'quick' })} />);
    fireEvent.click(screen.getByTestId('new-agent-project'));
    fireEvent.click(screen.getByRole('option', { name: /Goobers/ }));
    expect(screen.getByTestId('new-agent-project').textContent).toContain('Goobers');
    fireEvent.change(screen.getByLabelText('Runs in'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByTestId('new-agent-mission'), { target: { value: 'Run tests' } });
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalledWith('p2', '/tmp/gb', 'Run tests', 'default', 'a1', undefined, undefined));
  });

  it('the picker searches every project', () => {
    render(<NewAgentPage request={req()} />);
    fireEvent.click(screen.getByTestId('new-agent-project'));
    fireEvent.change(screen.getByLabelText('Find a project'), { target: { value: 'goob' } });
    const list = screen.getByRole('listbox', { name: 'Project' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Goobers')]);
  });

  it('hands the new agent id to the opener (canvas places a card for it)', async () => {
    const onCreated = vi.fn();
    render(<NewAgentPage request={req({ projectId: 'p2', onCreated })} />);
    expect(screen.getByTestId('new-agent-project').textContent).toContain('Goobers');
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('a-new'));
  });

  it('does not call back when creation fails', async () => {
    createDurableAgent.mockResolvedValue(null);
    const onCreated = vi.fn();
    render(<NewAgentPage request={req({ onCreated })} />);
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    await waitFor(() => expect(createDurableAgent).toHaveBeenCalled());
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('Cancel closes the page', () => {
    render(<NewAgentPage request={req()} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(useChromeStore.getState().newAgent).toBeNull();
  });
});
