import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, DurableAgentConfig } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentRowActions } from '../agents/useAgentRowActions';
import { CHROME_HELP_SECTIONS, HELP_SECTIONS, MANAGED_HELP_EDITS, managedHelpSections } from '../help/help-content';
import { legacyLabel, legacyLine, legacyUse } from './legacy';
import { loadManagedFlag, resetManagedFlag } from './managed-flag';
import { SwitchAgentsSettingsView } from './SwitchAgentsSettingsView';

const m = () => window.clubhouse.managed;

async function setFlag(on: boolean) {
  vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({ managedAgents: on } as never);
  resetManagedFlag();
  await loadManagedFlag();
}

const config = (id: string, over: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id, name: id, color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: `wt-${id}`, ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  resetManagedFlag();
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
  useAgentStore.setState({ agents: {} });
  useClubhouseModeStore.setState({ enabled: false, projectOverrides: {} });
  resetManagedFlag();
});

describe('legacy detection', () => {
  it('counts Clubhouse Mode only when it is on for the project and not turned off for the agent', () => {
    expect(legacyUse(config('a'), true)).toEqual({ clubhouseMode: true, persona: null });
    expect(legacyUse(config('a', { clubhouseModeOverride: true }), true)).toBeNull();
    expect(legacyUse(config('a'), false)).toBeNull();
  });

  it('names a persona, a custom one by its id, and ignores a managed agent', () => {
    expect(legacyUse(config('a', { persona: 'qa' }), false)).toEqual({ clubhouseMode: false, persona: 'Quality Assurance' });
    expect(legacyUse(config('a', { persona: 'my-reviewer' }), false)?.persona).toBe('my-reviewer');
    expect(legacyUse(config('a', { persona: 'qa', managed: { version: 1, blocks: [], skills: [], mcps: [] } }), true)).toBeNull();
  });

  it('says it in one plain line', () => {
    expect(legacyLine('ada', { clubhouseMode: true, persona: null })).toBe('ada uses Clubhouse Mode.');
    expect(legacyLine('ada', { clubhouseMode: false, persona: 'Researcher' })).toBe('ada uses the Researcher persona.');
    expect(legacyLine('ada', { clubhouseMode: true, persona: 'Researcher' })).toBe('ada uses Clubhouse Mode and the Researcher persona.');
    expect(legacyLabel(null)).toBe('Plain');
  });
});

describe('Apply and Extract persona in the agent menu', () => {
  const agent: Agent = { id: 'a1', projectId: 'p1', name: 'ada', kind: 'durable', status: 'sleeping', color: 'teal' };
  const ids = (actions: Array<{ id: string }>) => actions.map((a) => a.id);
  beforeEach(() => useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: 'proj' }] as never, activeProjectId: 'p1' }));

  it('stay with the flag off', async () => {
    await setFlag(false);
    const { result } = renderHook(() => useAgentRowActions(agent));
    expect(ids(result.current)).toEqual(expect.arrayContaining(['apply-persona', 'extract-persona']));
  });

  it('go with the flag on', async () => {
    await setFlag(true);
    const { result } = renderHook(() => useAgentRowActions(agent));
    await act(async () => { await Promise.resolve(); });
    expect(ids(result.current)).not.toContain('apply-persona');
    expect(ids(result.current)).not.toContain('extract-persona');
    expect(ids(result.current)).toContain('settings');
  });
});

describe('Help with the flag on', () => {
  it('drops Clubhouse Mode and personas from both shells', () => {
    for (const sections of [managedHelpSections(HELP_SECTIONS, false), managedHelpSections(CHROME_HELP_SECTIONS, true)]) {
      expect(sections.find((s) => s.id === 'personas')).toBeUndefined();
      expect(sections.flatMap((s) => s.topics).find((t) => t.id === 'agents-clubhouse-mode')).toBeUndefined();
    }
    expect(HELP_SECTIONS.find((s) => s.id === 'personas')).toBeDefined();
  });

  it('rewrites each article it names, and every edit still matches its article', () => {
    const chrome = CHROME_HELP_SECTIONS.flatMap((s) => s.topics);
    const edited = managedHelpSections(CHROME_HELP_SECTIONS, true).flatMap((s) => s.topics);
    for (const [id, edits] of Object.entries(MANAGED_HELP_EDITS)) {
      const before = chrome.find((t) => t.id === id)!.content;
      const after = edited.find((t) => t.id === id)!.content;
      for (const e of edits) {
        expect(before).toContain(e.from);
        expect(after).not.toContain(e.from);
      }
      // Folder contents like "personas" in Reset project stay: they describe what's on disk.
      expect(after).not.toMatch(/\*\*Persona|persona…|Clubhouse mode/i);
    }
  });
});

describe('Settings, Switch agents', () => {
  const lists: Record<string, DurableAgentConfig[]> = {
    alpha: [
      config('ada'),
      config('bea', { persona: 'qa' }),
      config('cal', { clubhouseModeOverride: true }),
      config('dot', { managed: { version: 1, blocks: [], skills: [], mcps: [] } }),
    ],
    beta: [config('eve', { worktreePath: undefined, persona: 'qa' }), config('fay')],
  };

  beforeEach(() => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'alpha', path: 'alpha' }, { id: 'p2', name: 'beta', displayName: 'Beta', path: 'beta' }] as never });
    // Clubhouse Mode is on for alpha only.
    useClubhouseModeStore.setState({ enabled: false, projectOverrides: { alpha: true }, loadSettings: vi.fn(async () => {}) } as never);
    useAgentStore.setState({ agents: { bea: { id: 'bea', status: 'running' } as Agent } });
    window.clubhouse.agent.listDurable = vi.fn(async (p: string) => lists[p]) as never;
  });

  const row = (name: string) => screen.getAllByTestId('managed-switch-row').find((r) => within(r).queryByText(name, { selector: 'span' }))!;
  const box = (name: string) => within(row(name)).getByRole('checkbox') as HTMLInputElement;

  it('lists unmanaged agents across projects with what they use, and ticks the legacy ones', async () => {
    render(<SwitchAgentsSettingsView />);
    await waitFor(() => expect(screen.getAllByTestId('managed-switch-row')).toHaveLength(5));
    expect(screen.queryByText('dot')).toBeNull();
    expect(row('ada')).toHaveTextContent('alpha · Clubhouse Mode');
    expect(row('bea')).toHaveTextContent('alpha · Clubhouse Mode, Quality Assurance persona · Running');
    expect(row('cal')).toHaveTextContent('alpha · Plain');
    expect(row('eve')).toHaveTextContent("Beta · Quality Assurance persona");
    expect(row('eve')).toHaveTextContent("Works in the project folder, so it can't be managed.");
    expect([box('ada').checked, box('bea').checked, box('cal').checked, box('eve').checked, box('fay').checked]).toEqual([true, true, false, false, false]);
    expect(box('eve').disabled).toBe(true);
    expect(screen.getByTestId('managed-switch-run')).toHaveTextContent('Switch 2 to managed');
    expect(screen.getByText(/A running agent gets the change at its next start\./)).toBeTruthy();
  });

  it('previews a row from previewConvert', async () => {
    const preview = vi.spyOn(m(), 'previewConvert').mockResolvedValue({ ok: true, value: { blocks: ['ada notes'], skills: ['ship'], mcps: [], notes: ['Its .mcp.json is copied aside.'] } });
    render(<SwitchAgentsSettingsView />);
    await waitFor(() => expect(screen.getAllByTestId('managed-switch-row')).toHaveLength(5));
    fireEvent.click(within(row('ada')).getByRole('button', { name: 'Preview' }));
    const shown = await within(row('ada')).findByTestId('managed-switch-preview');
    await waitFor(() => expect(shown).toHaveTextContent('Becomes: 1 block, skill ship.'));
    expect(shown).toHaveTextContent('Its .mcp.json is copied aside.');
    expect(preview).toHaveBeenCalledWith('alpha', 'ada');
  });

  it('switches each ticked agent with keep, one at a time, and reports failures by agent', async () => {
    const order: string[] = [];
    const convert = vi.spyOn(m(), 'convertAgent').mockImplementation(async (_p, id) => {
      order.push(id);
      return id === 'bea' ? { ok: false, code: 'invalid', message: 'Skill folder is a link.' } : { ok: true, value: { version: 1, blocks: [], skills: [], mcps: [] } };
    });
    render(<SwitchAgentsSettingsView />);
    await waitFor(() => expect(screen.getAllByTestId('managed-switch-row')).toHaveLength(5));
    fireEvent.click(box('fay'));
    expect(screen.getByTestId('managed-switch-run')).toHaveTextContent('Switch 3 to managed');
    fireEvent.click(screen.getByTestId('managed-switch-run'));

    const result = await screen.findByTestId('managed-switch-result');
    expect(order).toEqual(['ada', 'bea', 'fay']);
    expect(convert).toHaveBeenCalledWith('alpha', 'ada', true);
    expect(convert).toHaveBeenCalledWith('alpha', 'bea', true);
    expect(convert).toHaveBeenCalledWith('beta', 'fay', true);
    expect(convert.mock.calls.every((c) => c[2] === true && c[3] === undefined)).toBe(true);
    expect(result).toHaveTextContent('Switched 2 agents.');
    expect(within(result).getByTestId('managed-switch-failures')).toHaveTextContent("bea wasn't switched. Skill folder is a link.");
  });

  it('switches nothing until asked', async () => {
    const convert = vi.spyOn(m(), 'convertAgent');
    render(<SwitchAgentsSettingsView />);
    await waitFor(() => expect(screen.getAllByTestId('managed-switch-row')).toHaveLength(5));
    fireEvent.click(box('ada'));
    fireEvent.click(box('bea'));
    expect(screen.getByTestId('managed-switch-run')).toBeDisabled();
    expect(convert).not.toHaveBeenCalled();
  });
});
