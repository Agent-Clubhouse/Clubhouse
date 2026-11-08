import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../shared/types';
import type { ManagedAgentSetup, ManagedAgentStatus, ManagedPartSummary } from '../../../shared/managed-agents-types';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useToastStore } from '../../stores/toastStore';
import { useAgentSettingsPages } from '../agents/agentSettingsPages';
import { useAgentRowActions } from '../agents/useAgentRowActions';
import { SettingsCard } from '../agents/details/SettingsCard';
import { useAgentDetailsStore } from '../agents/details/detailsStore';
import { CLI_CHANGED_NOTE, RESUME_NOTE, resetSetupBarDismissals, SetupChangedBar, setupChangedText } from './SetupChangedBar';
import { ALREADY_PENDING, ManagedRestartHost, PENDING_RESTART_NOTE, requestManagedRestart, resetPendingRestarts, useManagedRestartRequests } from './restart';

const agent: Agent = {
  id: 'a1', projectId: 'p1', name: 'release-lead', kind: 'durable', status: 'running', color: 'teal',
  orchestrator: 'claude-code', model: 'claude-opus-5-5',
};

const m = () => window.clubhouse.managed;
const realOpenAgentSettings = useAgentStore.getState().openAgentSettings;

function status(over: Partial<ManagedAgentStatus> = {}): ManagedAgentStatus {
  return {
    managed: true, running: true, waiting: true, changes: ['Coding standards was edited', 'Playwright was added'],
    deliveredAt: '2026-11-07T10:00:00Z', cliChanged: false, ...over,
  };
}

function mockStatus(s: ManagedAgentStatus) {
  return vi.spyOn(m(), 'status').mockResolvedValue({ ok: true, value: s } as never);
}

function mockWorking(working: boolean) {
  return vi.spyOn(m(), 'isWorking').mockResolvedValue({ ok: true, value: working } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetSetupBarDismissals();
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
  useManagedRestartRequests.setState({ confirm: null, busy: false });
  useToastStore.setState({ toasts: [] });
  resetPendingRestarts();
});

const toasts = () => useToastStore.getState().toasts.map((t) => `${t.type}: ${t.message}`);

/** A restart main hasn't answered yet: the wait for the turn to end. */
function holdRestart() {
  let answer: (v: unknown) => void = () => {};
  const restart = vi.spyOn(m(), 'restart').mockImplementation(() => new Promise((r) => { answer = r; }) as never);
  return { restart, answer: (v: unknown) => answer(v) };
}

afterEach(() => {
  useProjectStore.setState({ projects: [] });
  useAgentStore.setState({ openAgentSettings: realOpenAgentSettings });
  useAgentSettingsPages.getState().reset();
  useAgentSettingsPages.getState().setRequestedPage(null);
});

describe('setupChangedText', () => {
  it('joins the changes with semicolons and ends with one period', () => {
    expect(setupChangedText(['Coding standards was edited', 'Playwright was added.'])).toBe(
      'Setup changed since this session started: Coding standards was edited; Playwright was added.',
    );
    expect(setupChangedText([])).toBe('Setup changed since this session started.');
  });
});

describe('SetupChangedBar', () => {
  it('shows what changed for a running managed agent that is waiting, with the resume note', async () => {
    mockStatus(status());
    render(<SetupChangedBar agent={agent} variant="dock" />);
    expect(await screen.findByTestId('setup-changed-text')).toHaveTextContent(
      'Setup changed since this session started: Coding standards was edited; Playwright was added.',
    );
    expect(screen.getByTestId('setup-changed-note')).toHaveTextContent(RESUME_NOTE);
    expect(screen.getByRole('button', { name: 'What changed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('shows nothing when nothing is waiting', async () => {
    const read = mockStatus(status({ waiting: false, changes: [] }));
    render(<SetupChangedBar agent={agent} variant="strip" />);
    await waitFor(() => expect(read).toHaveBeenCalledWith('/work/proj', 'a1'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('setup-changed-bar')).toBeNull();
  });

  it('says a CLI change starts a new conversation, and restarts fresh', async () => {
    mockStatus(status({ cliChanged: true, changes: ['The CLI changed to Codex'] }));
    mockWorking(false);
    const restart = vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: false } } as never);
    render(<SetupChangedBar agent={agent} variant="dock" />);
    expect(await screen.findByTestId('setup-changed-note')).toHaveTextContent(CLI_CHANGED_NOTE);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/work/proj', 'a1', { fresh: true }));
  });

  it('restarts straight away when the agent is not working', async () => {
    mockStatus(status());
    const working = mockWorking(false);
    const restart = vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: true } } as never);
    render(<SetupChangedBar agent={agent} variant="dock" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/work/proj', 'a1', {}));
    expect(working).toHaveBeenCalledWith('a1');
    expect(screen.queryByTestId('managed-restart-confirm')).toBeNull();
  });

  it('asks first while the agent is working, and "when this turn ends" passes whenTurnEnds', async () => {
    mockStatus(status());
    mockWorking(true);
    const restart = vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: true } } as never);
    render(<SetupChangedBar agent={agent} variant="dock" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    expect(await screen.findByTestId('managed-restart-confirm')).toBeTruthy();
    expect(restart).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart when this turn ends' }));
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/work/proj', 'a1', { whenTurnEnds: true }));
    await waitFor(() => expect(screen.queryByTestId('managed-restart-confirm')).toBeNull());
  });

  it('"when this turn ends" closes the confirm at once, says it is waiting, and a second Restart is told so', async () => {
    mockStatus(status());
    mockWorking(true);
    const held = holdRestart();
    render(<SetupChangedBar agent={agent} variant="dock" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart when this turn ends' }));
    // Main is still waiting for the turn, but nothing is held open.
    await waitFor(() => expect(screen.queryByTestId('managed-restart-confirm')).toBeNull());
    expect(held.restart).toHaveBeenCalledWith('/work/proj', 'a1', { whenTurnEnds: true });
    expect(screen.getByTestId('setup-changed-note')).toHaveTextContent(PENDING_RESTART_NOTE);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByTestId('setup-changed-error')).toHaveTextContent(ALREADY_PENDING);
    expect(held.restart).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('managed-restart-confirm')).toBeNull();
    // Answered: the note goes back to what restart does.
    await act(async () => { held.answer({ ok: true, value: { resumed: true } }); });
    expect(screen.getByTestId('setup-changed-note')).toHaveTextContent(RESUME_NOTE);
  });

  it('a waiting restart that fails shows why in the bar', async () => {
    mockStatus(status());
    mockWorking(true);
    const held = holdRestart();
    render(<SetupChangedBar agent={agent} variant="dock" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart when this turn ends' }));
    await waitFor(() => expect(screen.getByTestId('setup-changed-note')).toHaveTextContent(PENDING_RESTART_NOTE));
    await act(async () => { held.answer({ ok: false, code: 'failed', message: 'The agent stopped before its turn ended.' }); });
    expect(screen.getByTestId('setup-changed-error')).toHaveTextContent('The agent stopped before its turn ended.');
  });

  it('"Restart now" from the confirm restarts without waiting, and Cancel does nothing', async () => {
    mockStatus(status());
    mockWorking(true);
    const restart = vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: true } } as never);
    render(<SetupChangedBar agent={agent} variant="dock" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('managed-restart-confirm')).toBeNull());
    expect(restart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/work/proj', 'a1', {}));
  });

  it('shows a failed restart in the bar', async () => {
    mockStatus(status());
    mockWorking(false);
    vi.spyOn(m(), 'restart').mockResolvedValue({ ok: false, code: 'failed', message: 'The CLI did not stop.' } as never);
    render(<SetupChangedBar agent={agent} variant="dock" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    expect(await screen.findByTestId('setup-changed-error')).toHaveTextContent('The CLI did not stop.');
  });

  it('dismiss hides it until the next change', async () => {
    let current = status();
    vi.spyOn(m(), 'status').mockImplementation(async () => ({ ok: true, value: current }) as never);
    let changed: () => void = () => {};
    vi.spyOn(m(), 'onChanged').mockImplementation((l: () => void) => { changed = l; return () => {}; });
    render(<SetupChangedBar agent={agent} variant="dock" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('setup-changed-bar')).toBeNull();
    // The same changes again: still dismissed.
    await act(async () => { changed(); await Promise.resolve(); });
    expect(screen.queryByTestId('setup-changed-bar')).toBeNull();
    current = status({ changes: [...current.changes, 'GitHub was removed'] });
    await act(async () => { changed(); await Promise.resolve(); });
    expect(await screen.findByTestId('setup-changed-text')).toHaveTextContent('GitHub was removed');
  });

  it('What changed opens the agent settings on Preview', async () => {
    mockStatus(status());
    const open = vi.fn();
    useAgentStore.setState({ openAgentSettings: open } as never);
    render(<SetupChangedBar agent={agent} variant="dock" />);
    fireEvent.click(await screen.findByRole('button', { name: 'What changed' }));
    expect(open).toHaveBeenCalledWith('a1');
    expect(useAgentSettingsPages.getState().requestedPage).toEqual({ agentId: 'a1', page: 'preview' });
  });
});

describe('⋯ menu restart items', () => {
  const ids = (actions: Array<{ id: string }>) => actions.map((a) => a.id);

  it('appear for a running managed agent', async () => {
    mockStatus(status({ waiting: false, changes: [] }));
    const { result } = renderHook(() => useAgentRowActions(agent));
    await waitFor(() => expect(ids(result.current)).toContain('restart'));
    const labels = result.current.map((a) => a.label);
    expect(labels).toContain('Restart');
    expect(labels).toContain('Restart with a new conversation');
  });

  it('stay hidden for an unmanaged agent', async () => {
    const read = mockStatus(status({ managed: false, waiting: false, changes: [] }));
    const { result } = renderHook(() => useAgentRowActions(agent));
    await waitFor(() => expect(read).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(ids(result.current)).not.toContain('restart');
    expect(ids(result.current)).not.toContain('restart-fresh');
  });

  it('stay hidden for a sleeping agent', async () => {
    const read = mockStatus(status());
    const { result } = renderHook(() => useAgentRowActions({ ...agent, status: 'sleeping' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(ids(result.current)).not.toContain('restart');
    expect(read).not.toHaveBeenCalled();
  });

  it('Restart resumes and "a new conversation" passes fresh', async () => {
    mockStatus(status());
    mockWorking(false);
    const restart = vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: true } } as never);
    const { result } = renderHook(() => useAgentRowActions(agent));
    await waitFor(() => expect(ids(result.current)).toContain('restart'));
    await act(async () => { result.current.find((a) => a.id === 'restart')!.handler(); });
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/work/proj', 'a1', {}));
    await act(async () => { result.current.find((a) => a.id === 'restart-fresh')!.handler(); });
    await waitFor(() => expect(restart).toHaveBeenLastCalledWith('/work/proj', 'a1', { fresh: true }));
  });

  it('asks through the host while the agent is working', async () => {
    mockStatus(status());
    mockWorking(true);
    const restart = vi.spyOn(m(), 'restart').mockResolvedValue({ ok: true, value: { resumed: true } } as never);
    const { result } = renderHook(() => useAgentRowActions(agent));
    render(<ManagedRestartHost />);
    await waitFor(() => expect(ids(result.current)).toContain('restart-fresh'));
    await act(async () => { result.current.find((a) => a.id === 'restart-fresh')!.handler(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Restart when this turn ends' }));
    await waitFor(() => expect(restart).toHaveBeenCalledWith('/work/proj', 'a1', { fresh: true, whenTurnEnds: true }));
  });
});

describe('⋯ menu restart while one is waiting', () => {
  const target = { projectPath: '/work/proj', agentId: 'a1', agentName: 'release-lead' };

  it('closes the host confirm at once, toasts, and a later request is told a restart is waiting', async () => {
    mockWorking(true);
    const held = holdRestart();
    render(<ManagedRestartHost />);
    await act(async () => { await requestManagedRestart(target); });
    fireEvent.click(await screen.findByRole('button', { name: 'Restart when this turn ends' }));
    await waitFor(() => expect(screen.queryByTestId('managed-restart-confirm')).toBeNull());
    expect(toasts()).toContain('info: release-lead restarts when this turn ends.');
    await act(async () => { await requestManagedRestart(target, { fresh: true }); });
    expect(toasts()).toContain(`info: release-lead: ${ALREADY_PENDING}`);
    expect(screen.queryByTestId('managed-restart-confirm')).toBeNull();
    expect(held.restart).toHaveBeenCalledTimes(1);
    await act(async () => { held.answer({ ok: false, code: 'failed', message: 'Still working.' }); });
    expect(toasts()).toContain("error: Couldn't restart release-lead. Still working.");
  });
});

describe('Setup card', () => {
  const setup: ManagedAgentSetup = {
    version: 1, blocks: ['b1', 'b2', 'b3'], skills: ['s1', 's2'], mcps: ['m1'], templateId: 'builtin-template-release',
  };
  const part = (id: string, kind: ManagedPartSummary['kind'], name: string): ManagedPartSummary => ({
    id, kind, name, description: '', builtin: false, revision: 1, updatedAt: '', usedBy: [], templates: [], preview: '',
  });

  beforeEach(() => {
    useAgentDetailsStore.setState({ open: true, settingsOpen: true, focus: null });
    vi.spyOn(m(), 'getSetup').mockResolvedValue({ ok: true, value: setup } as never);
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({
      ok: true, value: [{ id: 'builtin-template-release', name: 'Release lead', description: '', builtin: true, setup: { blocks: [], skills: [], mcps: [] }, settings: {}, usedBy: 1 }],
    } as never);
    vi.spyOn(m(), 'listParts').mockImplementation(async (kind) => ({
      ok: true,
      value: kind === 'skill' ? [part('s1', 'skill', 'Release notes'), part('s2', 'skill', 'Changelog')]
        : kind === 'mcp' ? [part('m1', 'mcp', 'GitHub')]
          : [],
    }) as never);
  });

  it('replaces Settings for a managed agent, with the setup rows and what is waiting', async () => {
    mockStatus(status());
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    expect(await screen.findByRole('region', { name: 'Setup' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('Managed · Release lead · 2 changes waiting'));
    expect(screen.getByTestId('details-setup-managed')).toHaveTextContent('By Clubhouse');
    expect(screen.getByTestId('details-setup-template')).toHaveTextContent('Release lead');
    expect(screen.getByTestId('details-setup-instructions')).toHaveTextContent('3 blocks');
    await waitFor(() => expect(screen.getByTestId('details-setup-skills')).toHaveTextContent('Release notes, Changelog'));
    expect(screen.getByTestId('details-setup-mcp')).toHaveTextContent('GitHub');
    expect(screen.getByTestId('details-setup-runs-on')).toHaveTextContent('Claude Code · claude-opus-5-5');
    expect(screen.getByTestId('details-setup-waiting')).toHaveTextContent('Coding standards was edited');
    expect(screen.getByTestId('details-setup-waiting')).toHaveTextContent('Playwright was added');
    expect(screen.getByTestId('details-setup-note')).toHaveTextContent('Applies when it restarts or next wakes.');
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
  });

  it('says a restart is waiting for the turn to end', async () => {
    mockStatus(status());
    mockWorking(true);
    const held = holdRestart();
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart when this turn ends' }));
    await waitFor(() => expect(screen.getByTestId('details-setup-note')).toHaveTextContent(PENDING_RESTART_NOTE));
    expect(screen.queryByTestId('managed-restart-confirm')).toBeNull();
    await act(async () => { held.answer({ ok: true, value: { resumed: true } }); });
    expect(screen.getByTestId('details-setup-note')).toHaveTextContent('Applies when it restarts or next wakes.');
  });

  it('has no Waiting row, note or Restart when nothing is waiting, and Open builder goes to Instructions', async () => {
    mockStatus(status({ waiting: false, changes: [] }));
    vi.spyOn(m(), 'getSetup').mockResolvedValue({ ok: true, value: { ...setup, templateId: undefined, skills: [], mcps: [] } } as never);
    const open = vi.fn();
    useAgentStore.setState({ openAgentSettings: open } as never);
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    expect(await screen.findByRole('region', { name: 'Setup' })).toBeTruthy();
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent(/^Managed$/);
    expect(screen.getByTestId('details-setup-template')).toHaveTextContent('None');
    expect(screen.getByTestId('details-setup-skills')).toHaveTextContent('None');
    expect(screen.getByTestId('details-setup-mcp')).toHaveTextContent('None');
    expect(screen.queryByTestId('details-setup-waiting')).toBeNull();
    expect(screen.queryByTestId('details-setup-note')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open builder' }));
    expect(open).toHaveBeenCalledWith('a1');
    expect(useAgentSettingsPages.getState().requestedPage).toEqual({ agentId: 'a1', page: 'instructions' });
  });

  it('says an agent Clubhouse switched on its own was switched, until the line is dismissed (D59)', async () => {
    // Every subscriber hears it, as the real event reaches them all (the card's config reads listen too).
    const listeners = new Set<() => void>();
    vi.spyOn(m(), 'onChanged').mockImplementation((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; });
    let current = status({ waiting: false, changes: [], migrated: { from: 'clubhouse-mode', backup: '~/.clubhouse/managed-agents/before-managed/a1' } });
    vi.spyOn(m(), 'status').mockImplementation(async () => ({ ok: true, value: current }) as never);
    const dismiss = vi.spyOn(m(), 'dismissMigrationNotice').mockImplementation(async () => {
      current = status({ waiting: false, changes: [] });
      for (const fn of listeners) fn();
      return { ok: true, value: undefined } as never;
    });
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    expect(await screen.findByTestId('details-setup-migrated')).toHaveTextContent(
      'Switched to managed when Clubhouse updated. Its earlier files are kept in ~/.clubhouse/managed-agents/before-managed/a1.',
    );
    await act(async () => { fireEvent.click(screen.getByTestId('details-setup-migrated-dismiss')); });
    expect(dismiss).toHaveBeenCalledWith('/work/proj', 'a1');
    await waitFor(() => expect(screen.queryByTestId('details-setup-migrated')).toBeNull());
  });

  it('keeps Settings for an unmanaged agent', async () => {
    const read = vi.spyOn(m(), 'getSetup').mockResolvedValue({ ok: true, value: null } as never);
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    await waitFor(() => expect(read).toHaveBeenCalledWith('/work/proj', 'a1'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('region', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Setup' })).toBeNull();
  });
});
