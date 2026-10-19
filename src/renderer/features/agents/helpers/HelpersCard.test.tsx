import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, DurableAgentConfig, HelperDisposeChecks } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useUIStore } from '../../../stores/uiStore';
import { HelpersCard, helpersSummary } from './HelpersCard';
import { useProjectAgentConfigs } from './orchestration-hooks';

const PROJECT = path.join('/work', 'proj');
const folder = (name: string) => path.join(PROJECT, '.clubhouse', 'agents', name);

const lead: Agent = { id: 'lead', projectId: 'p1', name: 'epic-lead', kind: 'durable', status: 'running', color: 'teal' };

function config(id: string, name: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name, color: 'teal', createdAt: '2026-10-18T09:00:00Z', parentAgentId: 'lead', ...extra };
}

function railAgent(id: string, name: string, status: Agent['status'], extra: Partial<Agent> = {}): Agent {
  return { id, projectId: 'p1', name, kind: 'durable', status, color: 'teal', ...extra };
}

let configs: DurableAgentConfig[];
let checks: Record<string, HelperDisposeChecks>;

beforeEach(() => {
  configs = [
    { id: 'lead', name: 'epic-lead', color: 'teal', createdAt: '2026-10-18T09:00:00Z' },
    config('h1', 'impl-ipc', { branch: 'impl-ipc/work', worktreePath: folder('impl-ipc') }),
    config('h2', 'qa-settings', { branch: 'qa-settings/work', worktreePath: folder('qa-settings') }),
    config('h3', 'impl-store', { creation: { state: 'creating', startedAt: '2026-10-18T09:00:00Z' } }),
    config('h4', 'impl-docs', { creation: { state: 'failed', startedAt: '2026-10-18T09:00:00Z', reason: 'The branch impl-docs/work already exists' } }),
    config('d1', 'merge-1', { disposedAt: '2026-10-18T11:00:00Z' }),
    config('other', 'not-mine', { parentAgentId: 'someone-else' }),
  ];
  checks = {
    h1: { dirty: 3, unpushed: 2, unmerged: 2 },
    h2: { dirty: 0, unpushed: 0, unmerged: 0 },
  };
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: PROJECT }], activeProjectId: 'p1' } as never);
  useAgentStore.setState({
    agents: {
      lead,
      h1: railAgent('h1', 'impl-ipc', 'running'),
      h2: railAgent('h2', 'qa-settings', 'sleeping'),
      h3: railAgent('h3', 'impl-store', 'creating'),
      h4: railAgent('h4', 'impl-docs', 'error', { errorMessage: 'The branch impl-docs/work already exists' }),
    },
    activeAgentId: 'lead',
  } as never);
  window.clubhouse.agent.listDurable = vi.fn(async () => configs) as never;
  window.clubhouse.agent.getDisposeChecks = vi.fn(async (_p: string, id: string) => checks[id] ?? { dirty: 0, unpushed: 0, unmerged: 0 });
  window.clubhouse.agent.disposeHelper = vi.fn(async (_p: string, id: string) => {
    configs = configs.map((c) => (c.id === id ? { ...c, disposedAt: '2026-10-18T12:00:00Z' } : c));
    return { ok: true, message: 'Disposed' };
  });
  window.clubhouse.agent.removeDisposed = vi.fn(async (_p: string, id: string) => {
    configs = configs.filter((c) => c.id !== id);
    return { ok: true, message: 'Removed' };
  });
  window.clubhouse.agent.killAgent = vi.fn(async () => {});
});

afterEach(() => {
  useAgentStore.setState({ agents: {} } as never);
  useProjectStore.setState({ projects: [] });
});

function Harness({ orchestrating = true }: { orchestrating?: boolean }) {
  const { configs: list, reload } = useProjectAgentConfigs(PROJECT, 'p1');
  const [open, setOpen] = useState(true);
  if (!list) return null;
  return (
    <HelpersCard
      agent={lead}
      projectPath={PROJECT}
      configs={list}
      maxHelpers={5}
      orchestrating={orchestrating}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onRemoved={reload}
    />
  );
}

async function renderCard(orchestrating = true) {
  render(<Harness orchestrating={orchestrating} />);
  return await screen.findByTestId('details-card-helpers');
}

describe('helpersSummary', () => {
  it('counts against the limit and says what is starting', () => {
    expect(helpersSummary(0, 5, 0)).toBe('none');
    expect(helpersSummary(4, 5, 0)).toBe('4 of 5');
    expect(helpersSummary(4, 5, 1)).toBe('4 of 5 · 1 starting');
    expect(helpersSummary(2, undefined, 0)).toBe('2');
  });
});

describe('Helpers card (#2232)', () => {
  it('lists the direct helpers with state, branch and unsaved work', async () => {
    await renderCard();
    expect(screen.getByTestId('details-card-helpers-summary')).toHaveTextContent('4 of 5 · 1 starting');
    const list = screen.getByTestId('helpers-list');
    expect(within(list).queryByText('not-mine')).not.toBeInTheDocument();
    expect(within(list).queryByText('merge-1')).not.toBeInTheDocument();

    const h1 = screen.getByTestId('helper-row-h1');
    expect(within(h1).getByTestId('helper-state')).toHaveTextContent('Running');
    expect(h1).toHaveTextContent('impl-ipc/work');
    await waitFor(() => expect(within(h1).getByTestId('helper-work')).toHaveTextContent('3 uncommitted, 2 unpushed'));

    const h2 = screen.getByTestId('helper-row-h2');
    expect(within(h2).getByTestId('helper-state')).toHaveTextContent('Sleeping');
    await waitFor(() => expect(within(h2).getByTestId('helper-work')).toHaveTextContent('clean'));

    expect(within(screen.getByTestId('helper-row-h3')).getByTestId('helper-state')).toHaveTextContent('Starting');
    const h4 = screen.getByTestId('helper-row-h4');
    expect(within(h4).getByTestId('helper-state')).toHaveTextContent('Couldn’t start');
    expect(h4).toHaveTextContent('The branch impl-docs/work already exists');
    // A helper still starting, or one that failed, isn't checked for work.
    expect(window.clubhouse.agent.getDisposeChecks).not.toHaveBeenCalledWith(PROJECT, 'h3');
    expect(window.clubhouse.agent.getDisposeChecks).not.toHaveBeenCalledWith(PROJECT, 'h4');
  });

  it('opens a helper in the main pane', async () => {
    await renderCard();
    fireEvent.click(within(screen.getByTestId('helper-row-h2')).getByTestId('helper-open'));
    expect(useAgentStore.getState().activeAgentId).toBe('h2');
    expect(useUIStore.getState().explorerTab).toBe('agents');
  });

  it('sleeps a running helper and wakes a sleeping one', async () => {
    const spawn = vi.fn(async () => 'h2');
    useAgentStore.setState({ spawnDurableAgent: spawn } as never);
    await renderCard();
    const sleep = within(screen.getByTestId('helper-row-h1')).getByTestId('helper-sleep-wake');
    expect(sleep).toHaveTextContent('Sleep');
    fireEvent.click(sleep);
    await waitFor(() => expect(window.clubhouse.agent.killAgent).toHaveBeenCalledWith('h1', PROJECT, undefined));

    const wake = within(screen.getByTestId('helper-row-h2')).getByTestId('helper-sleep-wake');
    expect(wake).toHaveTextContent('Wake');
    fireEvent.click(wake);
    await waitFor(() => expect(spawn).toHaveBeenCalledWith('p1', PROJECT, expect.objectContaining({ id: 'h2' }), false));
  });

  it('disposes through the dispose dialog, not the delete dialog', async () => {
    await renderCard();
    fireEvent.click(within(screen.getByTestId('helper-row-h2')).getByTestId('helper-dispose'));
    const dialog = await screen.findByTestId('dispose-helper-dialog');
    expect(useAgentStore.getState().deleteDialogAgent).toBeFalsy();
    expect(dialog).toHaveTextContent('Dispose of qa-settings?');
    await waitFor(() => expect(screen.getByTestId('dispose-confirm')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('dispose-confirm'));
    await waitFor(() => expect(screen.queryByTestId('dispose-helper-dialog')).not.toBeInTheDocument());
    expect(window.clubhouse.agent.disposeHelper).toHaveBeenCalledWith(PROJECT, 'h2', undefined, { dirty: 0, unpushed: 0, unmerged: 0 });
    // It moves to Disposed.
    await waitFor(() => expect(screen.queryByTestId('helper-row-h2')).not.toBeInTheDocument());
    expect(screen.getByTestId('helpers-disposed-toggle')).toHaveTextContent('Disposed 2');
  });

  it('shows disposed helpers on request and removes one for good after a confirm', async () => {
    await renderCard();
    expect(screen.queryByTestId('helpers-disposed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('helpers-disposed-toggle'));
    const row = screen.getByTestId('disposed-row-d1');
    expect(row).toHaveTextContent('merge-1');

    fireEvent.click(within(row).getByTestId('disposed-remove'));
    expect(screen.getByText('Remove merge-1 for good?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-destructive-cancel'));
    expect(window.clubhouse.agent.removeDisposed).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByTestId('disposed-row-d1')).getByTestId('disposed-remove'));
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    await waitFor(() => expect(window.clubhouse.agent.removeDisposed).toHaveBeenCalledWith(PROJECT, 'd1'));
    await waitFor(() => expect(screen.queryByTestId('helpers-disposed-toggle')).not.toBeInTheDocument());
  });

  it('shows a refused remove', async () => {
    window.clubhouse.agent.removeDisposed = vi.fn(async () => ({ ok: false, message: 'merge-1 isn\'t disposed' }));
    await renderCard();
    fireEvent.click(screen.getByTestId('helpers-disposed-toggle'));
    fireEvent.click(within(screen.getByTestId('disposed-row-d1')).getByTestId('disposed-remove'));
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    expect(await screen.findByTestId('helpers-error')).toHaveTextContent('merge-1 isn\'t disposed');
  });

  it('says why there are none', async () => {
    configs = configs.filter((c) => c.parentAgentId !== 'lead');
    await renderCard(false);
    expect(screen.getByTestId('details-card-helpers')).toHaveTextContent('Orchestration is off, so epic-lead can’t start helpers.');
  });

  it('offers a review of a handed-off helper (#2251 hand_off)', async () => {
    configs = configs.map((c) => (c.id === 'h2' ? { ...c, handoff: { how: 'pushed', note: '', at: '2026-10-18T11:00:00Z' } } : c));
    await renderCard();
    expect(within(screen.getByTestId('helper-row-h2')).getByTestId('helper-state')).toHaveTextContent('Handed off');
    const ready = screen.getByTestId('helpers-ready');
    expect(ready).toHaveTextContent('qa-settings is handed off and ready to dispose');
    fireEvent.click(within(ready).getByRole('button', { name: 'Review' }));
    expect(await screen.findByTestId('dispose-helper-dialog')).toHaveTextContent('Dispose of qa-settings?');
  });
});
