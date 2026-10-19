import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

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
import { useChromeDialogStore } from '../sidebar/ChromeAgentDialogs';
import { getPersonaTemplate } from '../../features/personas';

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
  useChromeDialogStore.setState({ request: null });
  useChromeStore.setState({ newAgent: req(), newAgentBusy: false, lastProjectId: 'p2', projectActivity: {}, projectScopeId: null });
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
    openWith({});
    await waitFor(() => expect(screen.getByLabelText('Own worktree and branch')).toBeTruthy());
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Emerald' }));
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    expect(createDurableAgent).toHaveBeenCalledWith(
      { id: 'p1', path: '/tmp/ch' },
      expect.objectContaining({ name: 'keen-heron', color: 'emerald', useWorktree: true, orchestrator: 'claude-code', model: 'default' }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    await waitFor(() => expect(useAgentStore.getState().activeAgentId).toBe('a-new'));
    expect(useChromeStore.getState().newAgent).toBeNull();
  });

  it('checks a worktree name inline and keeps Create off until it is valid (#2221)', async () => {
    openWith({});
    await waitFor(() => expect(screen.getByLabelText('Own worktree and branch')).toBeTruthy());
    const input = screen.getByTestId('new-agent-name');
    fireEvent.change(input, { target: { value: 'My Agent' } });
    const error = screen.getByTestId('new-agent-name-error');
    expect(error.textContent).toBe('Use only letters, digits, - and _ in the agent name.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', error.id);
    expect(screen.getByTestId('new-agent-submit')).toBeDisabled();
    // The worktree help never shows a branch or folder the main process would refuse.
    expect(screen.queryByText('My Agent/standby')).toBeNull();
    expect(screen.getByText('name/standby')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    expect(createDurableAgent).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'my-agent' } });
    expect(screen.queryByTestId('new-agent-name-error')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText('my-agent/standby')).toBeTruthy();
    expect(screen.getByTestId('new-agent-submit')).not.toBeDisabled();
  });

  it('allows a free-form name when the worktree switch is off', async () => {
    openWith({});
    await waitFor(() => expect(screen.getByLabelText('Own worktree and branch')).toBeTruthy());
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'My Agent' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Own worktree and branch' }));
    expect(screen.queryByTestId('new-agent-name-error')).toBeNull();
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    expect(createDurableAgent).toHaveBeenCalledWith(
      { id: 'p1', path: '/tmp/ch' },
      expect.objectContaining({ name: 'My Agent', useWorktree: false }),
      expect.anything(),
    );
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
    await submitWhenReady();
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalledWith('p2', '/tmp/gb', 'Run tests', 'default', 'a1', undefined, undefined));
  });

  it('calls the CLI field "Runs on" (#2233)', () => {
    render(<NewAgentPage request={req()} />);
    expect(screen.getByLabelText('Runs on').tagName).toBe('SELECT');
    expect(screen.queryByText('Orchestrator', { selector: 'label' })).toBeNull();
  });

  it("says a quick agent in another agent's worktree runs on that agent's CLI", () => {
    render(<NewAgentPage request={req({ kind: 'quick' })} />);
    fireEvent.click(screen.getByTestId('new-agent-project'));
    fireEvent.click(screen.getByRole('option', { name: /Goobers/ }));
    fireEvent.change(screen.getByLabelText('Runs in'), { target: { value: 'a1' } });
    expect(screen.getByText('Runs on the same CLI as gallant-swift.')).toBeTruthy();
    expect(screen.getByLabelText('Runs on')).toBeDisabled();
  });

  it('offers the Orchestrator and Workhorse personas (#2233)', () => {
    render(<NewAgentPage request={req()} />);
    const personas = Array.from(screen.getByTestId('new-agent-persona').querySelectorAll('option')).map((o) => o.textContent);
    expect(personas).toEqual(expect.arrayContaining(['Orchestrator', 'Workhorse']));
  });

  it('shows the chosen persona\'s description under the dropdown, and the merged PM once', () => {
    render(<NewAgentPage request={req()} />);
    const select = screen.getByTestId('new-agent-persona') as HTMLSelectElement;
    const names = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(names.filter((n) => n === 'Project Manager')).toHaveLength(1);
    expect(names).not.toContain('Group Project PM');
    const reviewer = getPersonaTemplate('qa')!;
    expect(screen.queryByText(reviewer.description)).toBeNull();
    fireEvent.change(select, { target: { value: 'qa' } });
    expect(screen.getByText(reviewer.description)).toBeTruthy();
  });

  it('the picker searches every project', () => {
    render(<NewAgentPage request={req()} />);
    fireEvent.click(screen.getByTestId('new-agent-project'));
    fireEvent.change(screen.getByLabelText('Find a project'), { target: { value: 'goob' } });
    const list = screen.getByRole('listbox', { name: 'Project' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Goobers')]);
  });

  const submitWhenReady = async () => {
    const submit = screen.getByTestId('new-agent-submit') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
  };
  const openWith = (over: Partial<NewAgentRequest>) => {
    const request = req(over);
    useChromeStore.setState({ newAgent: request, newAgentBusy: false, newAgentKnownIds: null });
    return render(<NewAgentPage request={request} />);
  };

  it('waits for the git check before Create is enabled', async () => {
    let resolveGit: (v: boolean) => void = () => {};
    window.clubhouse.project.checkGit = vi.fn(() => new Promise<boolean>((r) => { resolveGit = r; }));
    render(<NewAgentPage request={req()} />);
    expect((screen.getByTestId('new-agent-submit') as HTMLButtonElement).disabled).toBe(true);
    resolveGit(true);
    await waitFor(() => expect((screen.getByTestId('new-agent-submit') as HTMLButtonElement).disabled).toBe(false));
  });

  it('hands the new agent id to the opener and, with stayInView, stays put', async () => {
    useUIStore.setState({ explorerTab: 'plugin:app:canvas' });
    const onCreated = vi.fn();
    const onClosed = vi.fn();
    openWith({ projectId: 'p2', onCreated, onClosed, stayInView: true });
    expect(screen.getByTestId('new-agent-project').textContent).toContain('Goobers');
    await submitWhenReady();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('a-new'));
    expect(onClosed).toHaveBeenCalledWith('a-new');
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:canvas');
    expect(useChromeStore.getState().newAgent).toBeNull();
  });

  it('keeps the form open, with the error inline, when creation fails', async () => {
    createDurableAgent.mockImplementation(async (_p: unknown, _i: unknown, opts: { onError: (m: string) => void }) => { opts.onError('branch exists'); return null; });
    const onCreated = vi.fn();
    openWith({ onCreated });
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    await submitWhenReady();
    expect((await screen.findByTestId('new-agent-error')).textContent).toBe("Couldn't create the agent: branch exists");
    expect(useChromeStore.getState().newAgent).not.toBeNull();
    expect(useChromeStore.getState().newAgentBusy).toBe(false);
    expect((screen.getByTestId('new-agent-name') as HTMLInputElement).value).toBe('keen-heron');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('shows a quick agent that fails to start inline, keeping the mission', async () => {
    spawnQuickAgent.mockRejectedValue(new Error('CLI not found'));
    openWith({ kind: 'quick' });
    fireEvent.change(screen.getByTestId('new-agent-mission'), { target: { value: 'Fix it' } });
    await submitWhenReady();
    expect((await screen.findByTestId('new-agent-error')).textContent).toBe("Couldn't start the agent: CLI not found");
    expect((screen.getByTestId('new-agent-mission') as HTMLTextAreaElement).value).toBe('Fix it');
    expect(useChromeStore.getState().newAgent).not.toBeNull();
  });

  it('is busy while creating: Cancel is disabled and the button says so', async () => {
    createDurableAgent.mockReturnValue(new Promise(() => {}));
    openWith({});
    await submitWhenReady();
    expect(screen.getByTestId('new-agent-submit').textContent).toBe('Creating…');
    expect((screen.getByText('Cancel') as HTMLButtonElement).disabled).toBe(true);
    expect(useChromeStore.getState().newAgentBusy).toBe(true);
  });

  describe('leaving while it creates', () => {
    const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

    it('onClosed waits for the creation, onCreated comes first, and nothing navigates', async () => {
      const pending = deferred<string | null>();
      createDurableAgent.mockReturnValue(pending.promise);
      const events: string[] = [];
      openWith({ onCreated: (id) => events.push(`created:${id}`), onClosed: (id) => events.push(`closed:${id}`) });
      await submitWhenReady();
      // The user goes to Help.
      act(() => { useUIStore.setState({ explorerTab: 'help' }); useChromeStore.getState().closeNewAgent(); });
      expect(events).toEqual([]);
      await act(async () => { pending.resolve('a-late'); await pending.promise; });
      expect(events).toEqual(['created:a-late', 'closed:a-late']);
      expect(useUIStore.getState().explorerTab).toBe('help');
      expect(useAgentStore.getState().activeAgentId).not.toBe('a-late');
    });

    it('leaves a page opened meanwhile alone', async () => {
      const pending = deferred<string | null>();
      createDurableAgent.mockReturnValue(pending.promise);
      const first = vi.fn();
      openWith({ onClosed: first });
      await submitWhenReady();
      act(() => useChromeStore.getState().openNewAgent('quick', 'p2'));
      const second = useChromeStore.getState().newAgent;
      await act(async () => { pending.resolve('a-late'); await pending.promise; });
      expect(useChromeStore.getState().newAgent).toBe(second);
      expect(first).toHaveBeenCalledExactlyOnceWith('a-late');
    });

    it('a failure after leaving ends with onClosed(null) and no onCreated', async () => {
      const pending = deferred<string>();
      spawnQuickAgent.mockReturnValue(pending.promise);
      const onCreated = vi.fn();
      const onClosed = vi.fn();
      openWith({ kind: 'quick', onCreated, onClosed });
      fireEvent.change(screen.getByTestId('new-agent-mission'), { target: { value: 'x' } });
      await submitWhenReady();
      act(() => useChromeStore.getState().closeNewAgent());
      expect(onClosed).not.toHaveBeenCalled();
      await act(async () => { pending.reject(new Error('nope')); await pending.promise.catch(() => {}); });
      expect(onClosed).toHaveBeenCalledExactlyOnceWith(null);
      expect(onCreated).not.toHaveBeenCalled();
    });
  });

  it('adding a project from the picker selects it and keeps the page', async () => {
    const added = { id: 'p3', name: 'Site', path: '/tmp/site' };
    useProjectStore.setState({
      pickAndAddProject: vi.fn(async () => {
        useProjectStore.setState((st) => ({ projects: [...st.projects, added] as never, activeProjectId: 'p3' }));
        return added;
      }),
    } as never);
    openWith({});
    fireEvent.click(screen.getByTestId('new-agent-project'));
    fireEvent.click(screen.getByText('Add project…'));
    await waitFor(() => expect(screen.getByTestId('new-agent-project').textContent).toContain('Site'));
    expect(useChromeStore.getState().newAgent).not.toBeNull();
  });

  it('From a template… hands the opener to the template dialogs instead of ending it', () => {
    const onCreated = vi.fn();
    const onClosed = vi.fn();
    openWith({ projectId: 'p2', onCreated, onClosed });
    fireEvent.click(screen.getByText('From a template…'));
    expect(useChromeStore.getState().newAgent).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    expect(useChromeDialogStore.getState().request).toEqual({ kind: 'gallery', projectId: 'p2', opener: { onCreated, onClosed, stayInView: undefined } });
  });

  it('From a template… is off while creating, and the hand-off refuses then', async () => {
    createDurableAgent.mockReturnValue(new Promise(() => {}));
    const onClosed = vi.fn();
    openWith({ onClosed });
    await submitWhenReady();
    const link = screen.getByText('From a template…') as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    fireEvent.click(link);
    expect(useChromeStore.getState().handOffNewAgent()).toBeNull();
    expect(useChromeStore.getState().newAgent).not.toBeNull();
    expect(useChromeDialogStore.getState().request).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('Cancel closes the page and tells the opener nothing was made', () => {
    const onClosed = vi.fn();
    openWith({ onClosed });
    fireEvent.click(screen.getByText('Cancel'));
    expect(useChromeStore.getState().newAgent).toBeNull();
    expect(onClosed).toHaveBeenCalledWith(null);
  });
});
