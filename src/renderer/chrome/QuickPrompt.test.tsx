import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../hooks/useModelOptions', () => ({
  useModelOptions: () => ({ options: [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }], loading: false }),
}));

import { QuickPrompt } from './QuickPrompt';
import { useQuickPromptStore } from './quickPromptStore';
import { useChromeStore } from './chromeStore';
import { useAgentStore } from '../stores/agentStore';
import { useProjectStore } from '../stores/projectStore';
import { useOrchestratorStore } from '../stores/orchestratorStore';
import { useUIStore } from '../stores/uiStore';
import { useDefaultAccessStore } from '../stores/defaultAccessStore';

const projects = [
  { id: 'p1', name: 'Clubhouse', path: '/tmp/ch' },
  { id: 'p2', name: 'Goobers', path: '/tmp/gb', orchestrator: 'codex-cli' },
];
let spawnQuickAgent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  spawnQuickAgent = vi.fn().mockResolvedValue('q-new');
  window.clubhouse.app.getDefaultAccess = vi.fn().mockResolvedValue('auto');
  useDefaultAccessStore.setState({ defaultAccess: 'auto' });
  useProjectStore.setState({ projects: projects as never, activeProjectId: 'p1', projectIcons: {} });
  useAgentStore.setState({ agents: {}, spawnQuickAgent } as never);
  useOrchestratorStore.setState({
    allOrchestrators: [
      { id: 'claude-code', displayName: 'Claude Code', capabilities: { permissions: true } },
      { id: 'codex-cli', displayName: 'Codex CLI', capabilities: { permissions: true } },
    ] as never,
    enabled: ['claude-code', 'codex-cli'],
    availability: {},
  });
  useUIStore.setState({ explorerTab: 'agents', activeHostId: null });
  useChromeStore.setState({ newAgent: null, lastProjectId: 'p2', projectScopeId: null });
  useQuickPromptStore.setState({ open: true });
});

const input = () => screen.getByRole('textbox', { name: 'What should this quick agent do?' });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const enter = () => fireEvent.submit(input().closest('form')!);

describe('QuickPrompt (#2812)', () => {
  it('opens as a named dialog with its one field focused and no details', () => {
    render(<QuickPrompt />);
    expect(screen.getByRole('dialog', { name: 'New quick agent' })).toBeTruthy();
    expect(input()).toHaveFocus();
    expect(screen.queryByTestId('quick-prompt-details')).toBeNull();
    // The project in view is the current one: nothing to choose.
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
  });

  it('starts a quick agent in the current project with the defaults on Enter, then opens it', async () => {
    render(<QuickPrompt />);
    type('  fix the flaky test  ');
    enter();
    await waitFor(() => expect(useQuickPromptStore.getState().open).toBe(false));
    // The project's CLI (Claude Code, the first enabled), default model, and no level picked: the Default access applies.
    expect(spawnQuickAgent).toHaveBeenCalledWith('p1', '/tmp/ch', 'fix the flaky test', 'default', undefined, 'claude-code', undefined, undefined, undefined, { fallbackAccess: 'auto' });
    expect(useAgentStore.getState().activeAgentId).toBe('q-new');
  });

  it('does nothing on Enter with no task', () => {
    render(<QuickPrompt />);
    type('   ');
    enter();
    expect(spawnQuickAgent).not.toHaveBeenCalled();
    expect(useQuickPromptStore.getState().open).toBe(true);
  });

  it('closes on Esc and on a click outside, without starting anything', () => {
    const { unmount } = render(<QuickPrompt />);
    type('something');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(useQuickPromptStore.getState().open).toBe(false);
    unmount();
    act(() => useQuickPromptStore.setState({ open: true }));
    render(<QuickPrompt />);
    fireEvent.click(screen.getByTestId('quick-prompt-overlay').firstElementChild!);
    expect(useQuickPromptStore.getState().open).toBe(false);
    expect(spawnQuickAgent).not.toHaveBeenCalled();
  });

  it('asks for a project inline where none is in view, starting at the last used, and its CLI follows', async () => {
    useUIStore.setState({ explorerTab: 'settings' });
    render(<QuickPrompt />);
    const project = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    expect(project.value).toBe('p2');
    type('triage');
    enter();
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalled());
    // Goobers runs on Codex (#2975).
    expect(spawnQuickAgent.mock.calls[0].slice(0, 6)).toEqual(['p2', '/tmp/gb', 'triage', 'default', undefined, 'codex-cli']);
  });

  it('lets details change the project, CLI, model and access for this one start', async () => {
    render(<QuickPrompt />);
    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Runs on' }), { target: { value: 'claude-code' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'opus' } });
    fireEvent.change(screen.getByTestId('quick-prompt-access'), { target: { value: 'plan' } });
    type('look around');
    enter();
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalled());
    expect(spawnQuickAgent).toHaveBeenCalledWith('p2', '/tmp/gb', 'look around', 'opus', undefined, 'claude-code', 'plan', undefined, undefined, { fallbackAccess: 'auto' });
  });

  it('keeps the task and says why when the start fails', async () => {
    spawnQuickAgent.mockRejectedValue(new Error('no CLI'));
    render(<QuickPrompt />);
    type('try it');
    enter();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't start the agent: no CLI");
    expect(useQuickPromptStore.getState().open).toBe(true);
    expect((input() as HTMLInputElement).value).toBe('try it');
    expect(input()).not.toBeDisabled();
  });
});
