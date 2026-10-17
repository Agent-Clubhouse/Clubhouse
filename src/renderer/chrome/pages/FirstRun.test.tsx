import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { FirstRun } from './FirstRun';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

let pickAndAddProject: ReturnType<typeof vi.fn>;
let addProject: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pickAndAddProject = vi.fn().mockResolvedValue(null);
  addProject = vi.fn().mockResolvedValue({ id: 'p1' });
  useProjectStore.setState({ projects: [], pickAndAddProject, addProject } as never);
  useOrchestratorStore.setState({
    allOrchestrators: [
      { id: 'claude-code', displayName: 'Claude Code' },
      { id: 'copilot-cli', displayName: 'GitHub Copilot' },
    ] as never,
    availability: {},
  });
  window.clubhouse.agent.checkOrchestrator = vi.fn(async (_path?: string, id?: string) => ({ available: id === 'claude-code' }));
});

describe('FirstRun', () => {
  it('welcomes, with three steps and the folder picker in step one', () => {
    render(<FirstRun />);
    const page = screen.getByTestId('first-run');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome to Clubhouse');
    const steps = within(page).getAllByRole('listitem').filter((li) => li.querySelector('h2'));
    expect(steps.map((s) => s.querySelector('h2')!.textContent)).toEqual(['Add a project', 'Start an agent', 'Review its changes']);
    expect(within(steps[0]).getByTestId('first-run-choose')).toBeTruthy();
    fireEvent.click(screen.getByTestId('first-run-choose'));
    expect(pickAndAddProject).toHaveBeenCalled();
    expect(page.textContent).not.toMatch(/Issues|experience/i);
  });

  it('shows which agent CLIs are installed, with an install link for the rest', async () => {
    render(<FirstRun />);
    const clis = screen.getByTestId('first-run-clis');
    await waitFor(() => expect(clis.textContent).toContain('Claude Codefound'));
    expect(within(clis).getByRole('button', { name: 'Install' })).toBeTruthy();
    expect(window.clubhouse.agent.checkOrchestrator).toHaveBeenCalledWith(undefined, 'copilot-cli');
  });

  it('leaves a slot for the mascots', () => {
    render(<FirstRun />);
    expect(screen.getByTestId('first-run-mascots')).toBeTruthy();
  });

  it('adds a dropped folder', () => {
    vi.spyOn(window.clubhouse, 'getPathForFile').mockReturnValue('/Users/me/src/site');
    render(<FirstRun />);
    const file = new File([], 'site');
    fireEvent.drop(screen.getByTestId('first-run'), { dataTransfer: { files: [file], types: ['Files'] } });
    expect(addProject).toHaveBeenCalledWith('/Users/me/src/site');
  });
});
