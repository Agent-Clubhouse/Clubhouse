import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../hooks/useModelOptions', () => ({
  useModelOptions: () => ({ options: [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }], loading: false }),
}));
const createDurableAgent = vi.fn();
vi.mock('../../features/agents/create-agent', () => ({ createDurableAgent: (...args: unknown[]) => createDurableAgent(...args) }));

import { NewAgentPage, quickTemplateHelp } from './NewAgentPage';
import { templateSummary } from './NewManagedAgentSteps';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useUIStore } from '../../stores/uiStore';
import { useChromeStore, type NewAgentRequest } from '../chromeStore';

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

// Cut from the built-ins (D71): agents made from it keep working, but nothing offers it.
const retiredTemplate = {
  id: 'builtin-template-project-manager',
  name: 'Project Manager',
  description: 'Replaced by Product Owner.',
  builtin: true,
  retired: true as const,
  setup: { blocks: ['b-identity', 'b-pm'], skills: [], mcps: ['builtin-mcp-clubhouse'] },
  settings: {},
  usedBy: 2,
};

let spawnDurableAgent: ReturnType<typeof vi.fn>;
const req = (over: Partial<NewAgentRequest> = {}): NewAgentRequest => ({ kind: 'durable', seq: 1, ...over });
const openWith = (over: Partial<NewAgentRequest> = {}) => {
  const request = req(over);
  useChromeStore.setState({ newAgent: request, newAgentBusy: false, newAgentKnownIds: null });
  return render(<NewAgentPage request={request} />);
};
const managedSwitch = () => screen.findByRole('switch', { name: 'Clubhouse managed' });

beforeEach(() => {
  vi.restoreAllMocks();
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
  useChromeStore.setState({ newAgent: req(), newAgentBusy: false, lastProjectId: 'p2', projectActivity: {}, projectScopeId: null });
});

describe('NewAgentPage with Clubhouse-managed agents (#2893)', () => {

  it('managed is on by default and swaps the runtime rows for the managed footer', async () => {
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
    const first = openWith();
    fireEvent.click(await managedSwitch());
    first.unmount();
    openWith();
    expect((await managedSwitch()).getAttribute('aria-checked')).toBe('false');
  });

  it('Start with template lists built-in and custom templates, and Create makes the agent from one', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [builtinTemplate, retiredTemplate, customTemplate] } as never);
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
    // A retired built-in isn't offered (D71).
    expect(screen.queryByTestId('managed-template-builtin-template-project-manager')).toBeNull();
    expect(screen.queryByText('Project Manager')).toBeNull();
    expect(screen.getByTestId('managed-template-custom-release').textContent).toContain('Custom');

    fireEvent.click(within(builtin).getByRole('button', { name: 'Create from Orchestrator' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', { name: 'keen-heron', color: 'emerald', templateId: 'builtin-template-orchestrator' }));
    await waitFor(() => expect(spawnDurableAgent).toHaveBeenCalledWith('p1', '/tmp/ch', expect.objectContaining({ id: 'm-new' }), false));
    await waitFor(() => expect(useChromeStore.getState().newAgent).toBeNull());
    expect(useAgentStore.getState().activeAgentId).toBe('m-new');
  });

  it('Customize opens the builder from the template, and Create agent sends the setup and settings', async () => {
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

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
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
    openWith();
    await managedSwitch();
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    fireEvent.click(screen.getByText('Back'));
    expect((screen.getByTestId('new-agent-name') as HTMLInputElement).value).toBe('keen-heron');
  });

  it('Copy another agent lists managed agents and opens the builder with its setup, model, CLI and Free Agent Mode', async () => {
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
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByRole('switch', { name: 'Can start helpers' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Helper limit') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', expect.objectContaining({
      settings: expect.objectContaining({ orchestration: { orchestrate: true, maxHelpers: 2, access: 'same' } }),
    })));
  });

  it('Back then forward to the same start keeps the builder draft, and the name can be fixed meanwhile', async () => {
    vi.spyOn(m(), 'createAgent')
      .mockResolvedValueOnce({ ok: false, code: 'name_taken' } as never)
      .mockResolvedValueOnce({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'keen-heron' } });
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
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
    openWith();
    await managedSwitch();
    fireEvent.click(screen.getByTestId('new-agent-scratch'));
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Can start helpers' }));
    fireEvent.keyDown(screen.getByLabelText('Helper limit'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByLabelText('Model'), { key: 'Escape' });
    expect(screen.getByTestId('new-agent-builder')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('heading', { name: /^Build / }), { key: 'Escape' });
    expect(screen.queryByTestId('new-agent-builder')).toBeNull();
    expect(screen.getByTestId('new-agent-name')).toBeTruthy();
  });

  it('⌘↵ inside the part dialog doesn\'t create the agent', async () => {
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

  it('can always start helpers: the Clubhouse MCP part is in every setup', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [{ ...builtinTemplate, setup: { ...builtinTemplate.setup, mcps: [] } }] } as never);
    const create = vi.spyOn(m(), 'createAgent').mockResolvedValue({ ok: true, value: { id: 'm-new' } } as never);
    openWith();
    await managedSwitch();
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    fireEvent.click(await screen.findByRole('button', { name: 'Customize Orchestrator' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    const helpers = screen.getByRole('switch', { name: 'Can start helpers' });
    expect(helpers).not.toBeDisabled();
    expect(screen.queryByText('Needs the Clubhouse MCP server.')).toBeNull();
    const before = helpers.getAttribute('aria-checked');
    fireEvent.click(helpers);
    const after = before === 'true' ? 'false' : 'true';
    expect(screen.getByRole('switch', { name: 'Can start helpers' }).getAttribute('aria-checked')).toBe(after);
    fireEvent.click(screen.getByTestId('new-agent-builder-create'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/tmp/ch', expect.objectContaining({
      settings: expect.objectContaining({ orchestration: expect.objectContaining({ orchestrate: after === 'true' }) }),
    })));
  });

  it('turning Clubhouse features off warns that hooks stop, not MCP, and creates the agent with them off', async () => {
    openWith();
    fireEvent.click(await managedSwitch());
    fireEvent.click(screen.getByRole('switch', { name: 'Clubhouse features' }));
    expect(screen.getByTestId('new-agent-features-warning').textContent).toBe(
      "Off: Clubhouse can't show this agent's status, permission prompts or changes.",
    );
    await waitFor(() => expect(screen.getByTestId('new-agent-submit')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    expect(createDurableAgent).toHaveBeenCalledWith(
      { id: 'p1', path: '/tmp/ch' },
      expect.objectContaining({ clubhouseFeatures: false }),
      expect.anything(),
    );
    expect(createDurableAgent.mock.calls[0][1]).not.toHaveProperty('persona');
  });

  it('a project on another computer can\'t be managed, and says why', async () => {
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

describe('NewAgentPage, a quick agent from a template (D25)', () => {
  const serverTemplate = {
    id: 'custom-workiq', name: 'WorkIQ reader', description: '', builtin: false,
    setup: { blocks: ['b-identity'], skills: [], mcps: ['builtin-mcp-clubhouse', 'p-workiq'] },
    settings: { model: 'opus', freeAgentMode: true }, usedBy: 0,
  };
  let spawnQuickAgent: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    spawnQuickAgent = vi.fn().mockResolvedValue('q-new');
    useAgentStore.setState({ spawnQuickAgent } as never);
  });
  const typeMission = () => fireEvent.change(screen.getByTestId('new-agent-mission'), { target: { value: 'Summarize the inbox' } });

  it('shows None and the templates under the mission box, keeps the mission, and starts from the one picked', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [builtinTemplate, retiredTemplate, serverTemplate] } as never);
    openWith({ kind: 'quick' });
    const select = await screen.findByTestId('new-agent-quick-template') as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(screen.getByTestId('new-agent-mission').compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Project Manager is retired (D71), so it isn't listed.
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['None', 'Orchestrator', 'WorkIQ reader (yours)']);
    expect(select.value).toBe('');
    expect(screen.getByTestId('new-agent-quick-template-help').textContent).toBe('Optional. Starts the agent with a template’s instructions and MCP servers.');

    fireEvent.change(select, { target: { value: 'custom-workiq' } });
    // The template fills in its model and Free Agent Mode; the rows stay to change them.
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('opus');
    expect(screen.getByRole('switch', { name: 'Free Agent Mode' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('new-agent-quick-template-help').textContent)
      .toBe('Its instructions lead the agent’s prompt. Its MCP server can’t reach Claude Code, which reads them only from the folder’s own MCP file.');

    typeMission();
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalled());
    const call = spawnQuickAgent.mock.calls[0];
    expect(call[2]).toBe('Summarize the inbox');
    expect(call[3]).toBe('opus');
    expect(call[9]).toEqual({ managedTemplateId: 'custom-workiq' });
  });

  it('leaves the model alone when the template\'s model is for a CLI that won\'t run', async () => {
    const otherCli = { ...serverTemplate, id: 'custom-codex', name: 'Codex reader', settings: { orchestrator: 'codex-cli', model: 'gpt-5-codex', freeAgentMode: true } };
    const noCli = { ...serverTemplate, id: 'custom-nocli', name: 'Loose', settings: { model: 'gpt-5-codex' } };
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [otherCli, noCli] } as never);
    openWith({ kind: 'quick' });
    const select = await screen.findByTestId('new-agent-quick-template') as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    const model = () => (screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value;
    // Codex isn't available here, so Claude Code runs and keeps its own model; Free Agent Mode still applies.
    fireEvent.change(select, { target: { value: 'custom-codex' } });
    expect(model()).toBe('default');
    expect(screen.getByRole('switch', { name: 'Free Agent Mode' }).getAttribute('aria-checked')).toBe('true');
    // No CLI named, and the model isn't one of the current CLI's.
    fireEvent.change(select, { target: { value: 'custom-nocli' } });
    expect(model()).toBe('default');
    typeMission();
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalled());
    expect(spawnQuickAgent.mock.calls[0][3]).not.toBe('gpt-5-codex');
  });

  it('None starts a quick agent with no template', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [serverTemplate] } as never);
    openWith({ kind: 'quick' });
    const select = await screen.findByTestId('new-agent-quick-template') as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'custom-workiq' } });
    fireEvent.change(select, { target: { value: '' } });
    typeMission();
    fireEvent.click(screen.getByTestId('new-agent-submit'));
    await waitFor(() => expect(spawnQuickAgent).toHaveBeenCalled());
    expect(spawnQuickAgent.mock.calls[0][9]).toBeUndefined();
  });
});

describe('quickTemplateHelp', () => {
  const opts = { mcpLaunchFlags: true, cliName: 'Codex' };
  const setup = (mcps: string[], skills: string[] = []) => ({ setup: { blocks: ['b'], skills, mcps } });

  it('says the servers are passed at launch on a CLI that takes them', () => {
    expect(quickTemplateHelp(setup(['builtin-mcp-clubhouse', 'a', 'b']), opts)).toBe('Its instructions lead the agent’s prompt. Its 2 MCP servers are passed at launch.');
  });

  it('says what can\'t reach the agent: servers on a CLI without launch flags and skills, never Clubhouse tools', () => {
    expect(quickTemplateHelp(setup(['a'], ['s1', 's2']), { mcpLaunchFlags: false, cliName: 'Claude Code' })).toBe(
      'Its instructions lead the agent’s prompt. Its MCP server can’t reach Claude Code, which reads them only from the folder’s own MCP file. Its skills aren’t used, since a quick agent has no folder of its own.',
    );
    expect(quickTemplateHelp(undefined, opts)).toBe('Optional. Starts the agent with a template’s instructions and MCP servers.');
  });
});
