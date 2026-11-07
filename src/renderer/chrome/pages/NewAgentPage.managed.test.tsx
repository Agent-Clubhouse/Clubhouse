import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../hooks/useModelOptions', () => ({
  useModelOptions: () => ({ options: [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }], loading: false }),
}));
const createDurableAgent = vi.fn();
vi.mock('../../features/agents/create-agent', () => ({ createDurableAgent: (...args: unknown[]) => createDurableAgent(...args) }));

import { NewAgentPage } from './NewAgentPage';
import { templateSummary } from './NewManagedAgentSteps';
import { resetManagedFlag } from '../../features/managed/managed-flag';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useUIStore } from '../../stores/uiStore';
import { useChromeStore, type NewAgentRequest } from '../chromeStore';
import { useChromeDialogStore } from '../sidebar/ChromeAgentDialogs';

const projects = [
  { id: 'p1', name: 'Clubhouse', path: '/tmp/ch' },
  { id: 'p2', name: 'Goobers', path: '/tmp/gb' },
];
const m = () => window.clubhouse.managed;

const builtinTemplate = {
  id: 'builtin-template-orchestrator',
  name: 'Orchestrator',
  description: 'Plans work and runs helpers to do it.',
  builtin: true,
  setup: { blocks: ['b-identity', 'b-orch'], skills: ['s-notes'], mcps: ['builtin-mcp-clubhouse'] },
  settings: { model: 'opus', orchestration: { orchestrate: true, maxHelpers: 3, access: 'same' as const } },
  usedBy: 0,
};
const customTemplate = {
  id: 'custom-release',
  name: 'Release lead',
  description: 'Cuts releases.',
  builtin: false,
  setup: { blocks: ['b-identity'], skills: [], mcps: [] },
  settings: {},
  usedBy: 1,
};

let spawnDurableAgent: ReturnType<typeof vi.fn>;
const req = (over: Partial<NewAgentRequest> = {}): NewAgentRequest => ({ kind: 'durable', seq: 1, ...over });
const openWith = (over: Partial<NewAgentRequest> = {}) => {
  const request = req(over);
  useChromeStore.setState({ newAgent: request, newAgentBusy: false, newAgentKnownIds: null });
  return render(<NewAgentPage request={request} />);
};
const flagOn = () => {
  vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({ managedAgents: true } as never);
};
const managedSwitch = () => screen.findByRole('switch', { name: 'Clubhouse managed' });

beforeEach(() => {
  vi.restoreAllMocks();
  resetManagedFlag();
  window.localStorage.clear();
  createDurableAgent.mockReset().mockResolvedValue('a-new');
  spawnDurableAgent = vi.fn().mockResolvedValue('m-new');
  window.clubhouse.project.checkGit = vi.fn().mockResolvedValue(true);
  useProjectStore.setState({ projects: projects as never, activeProjectId: 'p1', projectIcons: {} });
  useAgentStore.setState({
    agents: {
      a1: { id: 'a1', projectId: 'p2', name: 'gallant-swift', kind: 'durable', status: 'sleeping', color: 'blue', orchestrator: 'claude-code', model: 'opus', freeAgentMode: true },
      a2: { id: 'a2', projectId: 'p1', name: 'plain-otter', kind: 'durable', status: 'sleeping', color: 'emerald', orchestrator: 'claude-code' },
    } as never,
    spawnDurableAgent,
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

describe('NewAgentPage with Clubhouse-managed agents (#2893)', () => {
  it('with the flag off, the form is unchanged', async () => {
    openWith();
    await waitFor(() => expect(screen.getByLabelText('Own worktree and branch')).toBeTruthy());
    expect(screen.queryByRole('switch', { name: 'Clubhouse managed' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Clubhouse features' })).toBeNull();
    expect(screen.queryByTestId('new-agent-image')).toBeNull();
    expect(screen.getByTestId('new-agent-persona')).toBeTruthy();
    expect(screen.getByText('From a template…')).toBeTruthy();
    expect(screen.queryByText('Copy another agent…')).toBeNull();
    expect(screen.getByTestId('new-agent-submit').textContent).toBe('Create');
  });

  it('managed is on by default and swaps the runtime rows for the managed footer', async () => {
    flagOn();
    openWith();
    const toggle = await managedSwitch();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Clubhouse builds its instructions, skills, MCP servers and settings from parts you choose/)).toBeTruthy();
    expect(screen.getByTestId('new-agent-image')).toBeTruthy();
    expect(screen.queryByLabelText('Runs on')).toBeNull();
    expect(screen.queryByTestId('new-agent-persona')).toBeNull();
    expect(screen.queryByLabelText('Own worktree and branch')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Free Agent Mode' })).toBeNull();
    expect(screen.getByText('Copy another agent…')).toBeTruthy();
    expect(screen.getByTestId('new-agent-scratch').textContent).toBe('Build from scratch');
    expect(screen.getByTestId('new-agent-submit').textContent).toBe('Start with template');
    expect(screen.queryByText('From a template…')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByLabelText('Runs on')).toBeTruthy();
    expect(screen.queryByTestId('new-agent-persona')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Clubhouse features' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('new-agent-scratch')).toBeNull();
    expect(screen.queryByText('Copy another agent…')).toBeNull();
    expect(screen.getByTestId('new-agent-submit').textContent).toBe('Create');
    expect(screen.getByText('A plain agent. You manage its instructions, skills and MCP servers yourself.')).toBeTruthy();
  });

  it('remembers the last managed choice', async () => {
    flagOn();
    const first = openWith();
    fireEvent.click(await managedSwitch());
    first.unmount();
    openWith();
    expect((await managedSwitch()).getAttribute('aria-checked')).toBe('false');
  });

  it('Start with template lists built-in and custom templates, and Create makes the agent from one', async () => {
    flagOn();
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [builtinTemplate, customTemplate] } as never);
    const create = vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: true, value: { id: 'm-new', name: 'keen-heron', color: 'emerald' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Emerald' }));
    fireEvent.click(screen.getByTestId('new-agent-submit'));

    const builtin = await screen.findByTestId('managed-template-builtin-template-orchestrator');
    expect(within(screen.getByRole('region', { name: 'Built-in' })).getByText('Orchestrator')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Your templates' })).getByText('Release lead')).toBeTruthy();
    expect(builtin.textContent).toContain('2 blocks · 1 skill · 1 MCP server · helpers on, up to 3');
    expect(screen.getByTestId('managed-template-custom-release').textContent).toContain('Custom');

    fireEvent.click(within(builtin).getByRole('button', { name: 'Create from Orchestrator' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', { name: 'keen-heron', color: 'emerald', templateId: 'builtin-template-orchestrator' }));
    await waitFor(() => expect(spawnDurableAgent).toHaveBeenCalledWith('p1', '/tmp/ch', expect.objectContaining({ id: 'm-new' }), false));
    await waitFor(() => expect(useChromeStore.getState().newAgent).toBeNull());
    expect(useAgentStore.getState().activeAgentId).toBe('m-new');
  });

  it('Customize opens the builder from the template, and Create agent sends the setup and settings', async () => {
    flagOn();
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [builtinTemplate] } as never);
    const create = vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    fireEvent.click(await screen.findByRole('button', { name: 'Customize Orchestrator' }));

    expect(screen.getByRole('heading', { name: 'Build keen-heron' })).toBeTruthy();
    expect(screen.getByText('Clubhouse · from the Orchestrator template · nothing runs until you create it')).toBeTruthy();
    expect(await screen.findByTestId('managed-builder-instructions')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Settings' }));
    expect(screen.getByText("Instructions don't grant access. These settings do.")).toBeTruthy();
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('opus');
    expect(screen.getByRole('switch', { name: 'Can start helpers' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('Helper limit'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Free Agent Mode' }));

    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', {
      name: 'keen-heron',
      color: expect.any(String),
      setup: { blocks: ['b-identity', 'b-orch'], skills: ['s-notes'], mcps: ['builtin-mcp-clubhouse'], templateId: 'builtin-template-orchestrator' },
      settings: {
        orchestrator: 'claude-code',
        model: 'opus',
        freeAgentMode: true,
        orchestration: { orchestrate: true, maxHelpers: 4, access: 'same' },
      },
    }));
    await waitFor(() => expect(useChromeStore.getState().newAgent).toBeNull());
  });

  it('Build from scratch starts the builder with the identity block and the Clubhouse MCP server', async () => {
    flagOn();
    const create = vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    expect(screen.getByText(/· from scratch ·/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', expect.objectContaining({
      setup: { blocks: ['builtin-block-identity'], skills: [], mcps: ['builtin-mcp-clubhouse'] },
      settings: { orchestrator: 'claude-code', freeAgentMode: false, orchestration: { orchestrate: false } },
    })));
  });

  it('keeps the builder open with the error inline when creation fails', async () => {
    flagOn();
    vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: false, code: 'name_taken' } as never);
    openWith();
    await managedSwitch();
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    expect((await screen.findByTestId('new-agent-error')).textContent).toBe("Couldn't create the agent: That name is taken. Pick another.");
    expect(screen.getByTestId('new-agent-builder')).toBeTruthy();
    expect(spawnDurableAgent).not.toHaveBeenCalled();
  });

  it('Back returns to the form with the identity kept', async () => {
    flagOn();
    openWith();
    await managedSwitch();
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    fireEvent.click(screen.getByText('Back'));
    expect((screen.getByTestId('new-agent-name') as HTMLInputElement).value).toBe('keen-heron');
  });

  it('Copy another agent lists managed agents and opens the builder with its setup, model, CLI and Free Agent Mode', async () => {
    flagOn();
    vi.spyOn(m(), 'getSetup').mockImplementation(async (_path: string, id: string) => ({
      ok: true,
      value: id === 'a1' ? { version: 1, blocks: ['b-identity'], skills: ['s-notes'], mcps: [], templateId: 'custom-release' } : null,
    }) as never);
    const create = vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByText('Copy another agent…'));
    const list = await screen.findByRole('list', { name: 'Managed agents' });
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(within(list).queryByText('plain-otter')).toBeNull();
    fireEvent.click(within(list).getByText('gallant-swift'));
    expect(await screen.findByText('Clubhouse · copied from gallant-swift · nothing runs until you create it')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', expect.objectContaining({
      name: 'keen-heron',
      setup: { blocks: ['b-identity'], skills: ['s-notes'], mcps: [], templateId: 'custom-release' },
      settings: expect.objectContaining({ orchestrator: 'claude-code', model: 'opus', freeAgentMode: true }),
    })));
  });

  it('Copy another agent brings its orchestration from its config', async () => {
    flagOn();
    vi.spyOn(m(), 'getSetup').mockImplementation(async (_path: string, id: string) => ({
      ok: true, value: id === 'a1' ? { version: 1, blocks: ['b-identity'], skills: [], mcps: ['builtin-mcp-clubhouse'] } : null,
    }) as never);
    const config = vi.spyOn(window.clubhouse.agent, 'getDurableConfig').mockResolvedValue({ id: 'a1', orchestration: { orchestrate: true, maxHelpers: 2, access: 'same' } } as never);
    const create = vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.click(screen.getByText('Copy another agent…'));
    fireEvent.click(within(await screen.findByRole('list', { name: 'Managed agents' })).getByText('gallant-swift'));
    await screen.findByTestId('new-agent-builder');
    expect(config).toHaveBeenCalledWith('/tmp/gb', 'a1');
    fireEvent.click(screen.getByRole('radio', { name: 'Settings' }));
    expect(screen.getByRole('switch', { name: 'Can start helpers' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Helper limit') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', expect.objectContaining({
      settings: expect.objectContaining({ orchestration: { orchestrate: true, maxHelpers: 2, access: 'same' } }),
    })));
  });

  it('Back then forward to the same start keeps the builder draft, and the name can be fixed meanwhile', async () => {
    flagOn();
    vi.spyOn(m(), 'createAgent')
      .mockResolvedValueOnce({ ok: false, code: 'name_taken' } as never)
      .mockResolvedValueOnce({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    fireEvent.click(screen.getByRole('radio', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Free Agent Mode' }));
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    expect((await screen.findByTestId('new-agent-error')).textContent).toMatch(/That name is taken/);

    fireEvent.click(screen.getByText('Back'));
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron-2' } });
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    // Same tab, same switch.
    expect(screen.getByRole('switch', { name: 'Free Agent Mode' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    await waitFor(() => expect(m().createAgent).toHaveBeenLastCalledWith('/tmp/ch', expect.objectContaining({
      name: 'keen-heron-2',
      settings: expect.objectContaining({ freeAgentMode: true }),
    })));
  });

  it('Esc in a field of the builder doesn\'t go Back; Esc elsewhere does', async () => {
    flagOn();
    openWith();
    await managedSwitch();
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    fireEvent.click(screen.getByRole('radio', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Can start helpers' }));
    fireEvent.keyDown(screen.getByLabelText('Helper limit'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByLabelText('Model'), { key: 'Escape' });
    expect(screen.getByTestId('new-agent-builder')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('heading', { name: /^Build / }), { key: 'Escape' });
    expect(screen.queryByTestId('new-agent-builder')).toBeNull();
    expect(screen.getByTestId('new-agent-name')).toBeTruthy();
  });

  it('⌘↵ inside the part dialog doesn\'t create the agent', async () => {
    flagOn();
    const create = vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    fireEvent.click(screen.getByTestId('managed-write-block'));
    const dialog = await screen.findByTestId('managed-part-dialog');
    fireEvent.keyDown(within(dialog).getByLabelText('Name'), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(within(dialog).getByLabelText('Name'), { key: 'Enter', ctrlKey: true });
    expect(create).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('heading', { name: /^Build / }), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it('helpers need the Clubhouse MCP server', async () => {
    flagOn();
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [{ ...builtinTemplate, setup: { ...builtinTemplate.setup, mcps: [] } }] } as never);
    const create = vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    fireEvent.click(await screen.findByRole('button', { name: 'Customize Orchestrator' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Settings' }));
    const helpers = screen.getByRole('switch', { name: 'Can start helpers' });
    expect(helpers).toBeDisabled();
    expect(helpers.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Needs the Clubhouse MCP server.')).toBeTruthy();
    expect(screen.queryByLabelText('Helper limit')).toBeNull();
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', expect.objectContaining({
      settings: expect.objectContaining({ orchestration: expect.objectContaining({ orchestrate: false }) }),
    })));
  });

  it('turning Clubhouse features off warns what stops working and creates the agent with them off', async () => {
    flagOn();
    openWith();
    fireEvent.click(await managedSwitch());
    fireEvent.click(screen.getByRole('switch', { name: 'Clubhouse features' }));
    expect(screen.getByTestId('new-agent-features-warning').textContent).toBe(
      "Off: Clubhouse can't show this agent's status, permission prompts or changes, and the agent can't use helpers, messages or the Dispatcher.",
    );
    await waitFor(() => expect(screen.getByTestId('new-agent-submit')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    expect(createDurableAgent).toHaveBeenCalledWith(
      { id: 'p1', path: '/tmp/ch' },
      expect.objectContaining({ clubhouseFeatures: false, persona: undefined }),
      expect.anything(),
    );
  });

  it('a project on another computer can\'t be managed, and says why', async () => {
    flagOn();
    useProjectStore.setState({ projects: [...projects, { id: 'remote||sat||p9', name: 'Far', path: '/far' }] as never });
    openWith({ projectId: 'remote||sat||p9' });
    const toggle = await managedSwitch();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Not available yet for a project on another computer.')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Clubhouse features' })).toBeNull();
  });
});

describe('templateSummary', () => {
  it('counts parts and adds helpers only when orchestration is on', () => {
    expect(templateSummary(customTemplate)).toBe('1 block · 0 skills · 0 MCP servers');
    expect(templateSummary(builtinTemplate)).toBe('2 blocks · 1 skill · 1 MCP server · helpers on, up to 3');
  });
});
