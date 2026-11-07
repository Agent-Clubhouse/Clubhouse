import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedPartConsumer, ManagedPartSummary, ManagedTemplate } from '../../../shared/managed-agents-types';
import { HELPER_ROUTING_LABELS } from '../../../shared/helper-routing';
import { HelpersSettingsView } from '../settings/HelpersSettingsView';
import { resetManagedFlag } from './managed-flag';
import { PartLibraryView } from './PartLibraryView';
import { TemplatesSettingsView } from './TemplatesSettingsView';

const m = () => window.clubhouse.managed;

const consumer = (agentId: string, running = false): ManagedPartConsumer => ({
  projectPath: '/p', projectName: 'Clubhouse', agentId, agentName: agentId, color: 'indigo', running,
});

function part(id: string, over: Partial<ManagedPartSummary> = {}): ManagedPartSummary {
  return {
    id, kind: 'block', name: id, description: '', builtin: false, revision: 3, updatedAt: new Date().toISOString(), usedBy: [], templates: [], preview: '',
    ...over,
  };
}

function template(id: string, over: Partial<ManagedTemplate> = {}): ManagedTemplate & { usedBy: number } {
  return { id, name: id, description: '', builtin: false, setup: { blocks: [], skills: [], mcps: [] }, settings: {}, usedBy: 0, ...over };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetManagedFlag();
});

afterEach(() => {
  resetManagedFlag();
});

describe('Agent parts library page', () => {
  const parts = [
    part('coding', { name: 'Coding standards', usedBy: [consumer('ada'), consumer('scout'), consumer('lead'), consumer('qa')] }),
    part('identity', { name: 'Identity', builtin: true, usedBy: [consumer('ada')] }),
    part('fork', { name: 'Coding standards, ada', usedBy: [consumer('ada')], updatedBy: 'Dispatcher' }),
  ];

  it('lists parts and hides custom parts used by one agent until the switch is on', async () => {
    vi.spyOn(m(), 'listParts').mockResolvedValue({ ok: true, value: parts });
    render(<PartLibraryView kind="block" />);
    const rows = await screen.findAllByTestId('managed-library-row');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Coding standards'), expect.stringContaining('Identity')]);
    expect(rows[0].textContent).toContain('Custom');
    expect(rows[1].textContent).toContain('Built-in');
    expect(within(rows[0]).getByLabelText('Used by 4 agents')).toBeTruthy();
    expect(screen.getByTestId('managed-library-hidden').textContent).toBe('1 hidden');
    expect(screen.getByText('Agent parts your agents use. Built-in parts update with Clubhouse.')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'Show parts used by one agent' }));
    const all = screen.getAllByTestId('managed-library-row');
    expect(all).toHaveLength(3);
    expect(all[2].textContent).toContain('by Dispatcher');
    expect(screen.queryByTestId('managed-library-hidden')).toBeNull();
  });

  it('filters by source and search', async () => {
    vi.spyOn(m(), 'listParts').mockResolvedValue({ ok: true, value: parts });
    render(<PartLibraryView kind="block" />);
    await screen.findAllByTestId('managed-library-row');
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'builtin' } });
    expect(screen.getAllByTestId('managed-library-row').map((r) => r.textContent)).toEqual([expect.stringContaining('Identity')]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search instruction blocks' }), { target: { value: 'coding' } });
    expect(screen.getAllByTestId('managed-library-row')).toHaveLength(1);
  });

  it('opens a part with its text and who uses it, and offers only a copy for a built-in', async () => {
    vi.spyOn(m(), 'listParts').mockResolvedValue({ ok: true, value: [...parts, part('core', { name: 'Core', builtin: true, usedBy: [consumer('lead', true)], templates: [{ id: 't1', name: 'Orchestrator' }] })] });
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...part('core', { builtin: true }), content: { kind: 'block', content: 'Be kind.' } } });
    render(<PartLibraryView kind="block" />);
    const row = (await screen.findAllByTestId('managed-library-row')).find((r) => r.textContent?.includes('Core'))!;
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    const detail = screen.getByTestId('managed-part-detail');
    expect((await within(detail).findByTestId('managed-part-text')).textContent).toBe('Be kind.');
    expect(within(detail).getByTestId('managed-part-consumers').textContent).toMatch(/lead.*Running.*Orchestrator.*Template/);
    expect(within(detail).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(within(detail).queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(within(detail).getByRole('button', { name: 'Make your copy of Core' })).toBeTruthy();
  });

  it('says to set env values a part was stored with in the environment (D46)', async () => {
    const mcp = part('old', { kind: 'mcp', name: 'Old server', usedBy: [consumer('ada'), consumer('scout')], droppedEnvValues: ['MODE'] });
    vi.spyOn(m(), 'listParts').mockResolvedValue({ ok: true, value: [mcp] });
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...mcp, content: { kind: 'mcp', serverKey: 'old', transport: 'stdio', command: 'old', envVars: ['MODE'] } } });
    render(<PartLibraryView kind="mcp" />);
    const [row] = await screen.findAllByTestId('managed-library-row');
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    const detail = screen.getByTestId('managed-part-detail');
    expect(within(detail).getByTestId('managed-part-dropped-env').textContent).toBe('Set MODE in your environment. Clubhouse no longer stores this value.');
  });

  it('deletes a part in use with the chosen outcome', async () => {
    vi.spyOn(m(), 'listParts').mockResolvedValue({ ok: true, value: parts });
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: { ...parts[0], content: { kind: 'block', content: 'x' } } });
    const del = vi.spyOn(m(), 'deletePart').mockResolvedValue({ ok: true, value: undefined });
    render(<PartLibraryView kind="block" />);
    const [row] = await screen.findAllByTestId('managed-library-row');
    fireEvent.click(within(row).getByRole('button', { expanded: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete Coding standards' }));
    let dialog = screen.getByTestId('managed-delete-dialog');
    expect((within(dialog).getByRole('radio', { name: /Give each agent its own copy/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByTestId('managed-delete-confirm'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('coding', 3, 'copy'));
    await waitFor(() => expect(screen.queryByTestId('managed-delete-dialog')).toBeNull());

    fireEvent.click(within(screen.getAllByTestId('managed-library-row')[0]).getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Coding standards' }));
    dialog = screen.getByTestId('managed-delete-dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Remove it from those agents/ }));
    fireEvent.click(within(dialog).getByTestId('managed-delete-confirm'));
    await waitFor(() => expect(del).toHaveBeenLastCalledWith('coding', 3, 'remove'));
  });
});

describe('Templates page', () => {
  it('lists yours and built-in templates with their agent counts', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [template('mine', { name: 'Release lead', usedBy: 2 }), template('builtin-orch', { name: 'Orchestrator', builtin: true })] });
    const save = vi.spyOn(m(), 'saveTemplate').mockResolvedValue({ ok: true, value: template('copy', { name: 'Orchestrator copy' }) });
    render(<TemplatesSettingsView />);
    const yours = await screen.findByTestId('managed-templates-yours');
    expect(within(yours).getByText('Release lead')).toBeTruthy();
    expect(within(yours).getByText('2 agents')).toBeTruthy();
    const builtin = screen.getByTestId('managed-templates-builtin');
    expect(within(builtin).getByText('No agents')).toBeTruthy();
    fireEvent.click(within(builtin).getByRole('button', { name: 'Make your copy of Orchestrator' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ name: 'Orchestrator copy', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} }));
  });

  it('saving lists the changes and agents, and applies to the ticked agents only', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [template('mine', { name: 'Release lead', usedBy: 2, settings: { orchestration: { orchestrate: true, maxHelpers: 5 } } })] });
    const preview = vi.spyOn(m(), 'previewTemplatePush').mockResolvedValue({ ok: true, value: {
      changes: [
        { kind: 'add', part: 'skill', id: 's1', name: 'changelog-check' },
        { kind: 'remove', part: 'mcp', id: 'm1', name: 'Playwright' },
        { kind: 'setting', key: 'orchestration.maxHelpers', from: '5', to: '3' },
      ],
      targets: [
        { projectPath: '/p', agentId: 'ada', agentName: 'ada', color: 'indigo', running: false, applicable: 2, total: 3, note: 'already has no Playwright' },
        { projectPath: '/p', agentId: 'scout', agentName: 'scout', color: 'teal', running: true, applicable: 3, total: 3 },
      ],
    } });
    const push = vi.spyOn(m(), 'pushTemplate').mockResolvedValue({ ok: true, value: { failed: [] } });
    const save = vi.spyOn(m(), 'saveTemplate').mockResolvedValue({ ok: true, value: template('mine') });
    render(<TemplatesSettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Release lead' }));
    const max = screen.getByLabelText('Most helpers at once');
    fireEvent.change(max, { target: { value: '3' } });
    fireEvent.blur(max);
    fireEvent.click(screen.getByTestId('managed-template-save'));

    const dialog = await screen.findByTestId('managed-template-push-dialog');
    const next = { setup: { blocks: [], skills: [], mcps: [] }, settings: { orchestration: { orchestrate: true, maxHelpers: 3 } } };
    expect(preview).toHaveBeenCalledWith('mine', next);
    expect(within(dialog).getByTestId('managed-template-changes').textContent).toBe('+ Skill changelog-check− MCP server Playwright~ Helper limit 5 → 3');
    const targets = within(dialog).getByTestId('managed-template-targets');
    expect(targets.textContent).toContain('2 of 3 changes apply · already has no Playwright');
    expect(targets.textContent).toContain('3 of 3 changes apply · applies on restart');
    expect(within(dialog).getByTestId('managed-template-save-apply').textContent).toBe('Save and apply to 2');

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Apply to ada' }));
    fireEvent.click(within(dialog).getByTestId('managed-template-save-apply'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('mine', next, [{ projectPath: '/p', agentId: 'scout' }]));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ id: 'mine', name: 'Release lead', description: '', ...next }));
    expect((await screen.findByTestId('managed-template-notice')).textContent).toBe('Saved Release lead and applied it to 1 agent.');
  });

  it('save template only saves without pushing, and failed pushes are reported', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [template('mine', { name: 'Release lead', usedBy: 1 })] });
    vi.spyOn(m(), 'previewTemplatePush').mockResolvedValue({ ok: true, value: {
      changes: [{ kind: 'setting', key: 'orchestration.orchestrate', from: 'unset', to: 'true' }],
      targets: [{ projectPath: '/p', agentId: 'ada', agentName: 'ada', color: 'indigo', running: false, applicable: 1, total: 1 }],
    } });
    const push = vi.spyOn(m(), 'pushTemplate').mockResolvedValue({ ok: true, value: { failed: [{ agentId: 'ada', message: 'Skill folder clash' }] } });
    const save = vi.spyOn(m(), 'saveTemplate').mockResolvedValue({ ok: true, value: template('mine') });
    render(<TemplatesSettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Release lead' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Orchestration' }));
    fireEvent.click(screen.getByTestId('managed-template-save'));
    let dialog = await screen.findByTestId('managed-template-push-dialog');
    expect(within(dialog).getByTestId('managed-template-changes').textContent).toBe('~ Orchestration unset → on');
    fireEvent.click(within(dialog).getByTestId('managed-template-save-only'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Release lead' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Orchestration' }));
    fireEvent.click(screen.getByTestId('managed-template-save'));
    dialog = await screen.findByTestId('managed-template-push-dialog');
    fireEvent.click(within(dialog).getByTestId('managed-template-save-apply'));
    expect((await screen.findByTestId('managed-template-notice')).textContent).toBe("Saved Release lead. Couldn't apply it to ada (Skill folder clash).");
  });

  it('deletes one of yours from its menu', async () => {
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [template('mine', { name: 'Release lead' })] });
    const del = vi.spyOn(m(), 'deleteTemplate').mockResolvedValue({ ok: true, value: undefined });
    render(<TemplatesSettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Release lead' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('mine'));
  });
});

describe('Helpers page with managed agents', () => {
  beforeEach(() => {
    window.clubhouse.app.getHelperRouting = vi.fn(async () => ({ revision: 'r0.0', serverTime: '2026-11-01T00:00:00.000Z', labels: HELPER_ROUTING_LABELS, providers: {}, auto: { effective: false, source: 'default', scopes: { app: { value: false, editable: true } } } })) as never;
  });

  it('saves the default helper template and names Smart helper selection', async () => {
    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({ managedAgents: true } as never);
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [template('builtin-template-helper', { name: 'Helper', builtin: true }), template('qa', { name: 'Quality Assurance', builtin: true })] });
    const set = vi.spyOn(m(), 'setDefaultHelperTemplate').mockResolvedValue({ ok: true, value: undefined });
    render(<HelpersSettingsView />);
    const select = await screen.findByTestId('helpers-default-template') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('builtin-template-helper'));
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(screen.getByText('Used when an orchestrator starts a helper without naming one. Helpers are always Clubhouse managed.')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'qa' } });
    await waitFor(() => expect(set).toHaveBeenCalledWith('qa'));
    expect(select.value).toBe('qa');
    expect(screen.getByRole('heading', { name: 'Smart helper selection' })).toBeTruthy();
    expect(screen.getByTestId('helper-presets-footer').textContent).toBe('Smart helper selection balances load across your providers. Built-in templates ask orchestrators to use it.');
  });

  it('lets orchestrators choose helper templates only when turned on, off by default (D31)', async () => {
    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({ managedAgents: true } as never);
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [template('builtin-template-helper', { name: 'Helper', builtin: true })] });
    const set = vi.spyOn(m(), 'setHelperTemplateChoice').mockResolvedValue({ ok: true, value: undefined });
    render(<HelpersSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Let orchestrators choose helper templates' });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Every helper gets the default helper template. An orchestrator that names another template or changes parts is told to ask you.')).toBeTruthy();
    // Under the Default helper template select, in the Template section.
    const select = screen.getByTestId('helpers-default-template');
    expect(select.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(set).toHaveBeenCalledWith(true));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('An orchestrator can name any template, and add or leave out parts, for one helper. Nothing it picks is saved.')).toBeTruthy();
  });

  it('puts the toggle back and says why when saving it fails', async () => {
    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({ managedAgents: true } as never);
    vi.spyOn(m(), 'getHelperTemplateChoice').mockResolvedValue({ ok: true, value: true });
    vi.spyOn(m(), 'setHelperTemplateChoice').mockResolvedValue({ ok: false, code: 'failed', message: 'disk full' });
    render(<HelpersSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Let orchestrators choose helper templates' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(toggle);
    expect(await screen.findByTestId('helpers-template-choice-error')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('looks as before with the flag off', async () => {
    render(<HelpersSettingsView />);
    expect(await screen.findByRole('heading', { name: 'Presets by difficulty' })).toBeTruthy();
    expect(screen.queryByTestId('helpers-default-template')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Let orchestrators choose helper templates' })).toBeNull();
    expect(screen.queryByTestId('helper-presets-footer')).toBeNull();
  });
});
