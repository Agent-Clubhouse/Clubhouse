import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, DurableAgentConfig, HelperDisposeChecks, HelperInProject } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useUIStore } from '../../../stores/uiStore';
import { HelpersCard, helpersSummary } from './HelpersCard';
import { useHelperStartApprovals } from './orchestration-hooks';
import { useHelpersEverywhere } from './cross-project';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import { useHelperStartRequestStore } from '../../../stores/helperStartRequestStore';
import type { HelperStartRequest } from '../../../../shared/types';

const PROJECT = path.join('/work', 'proj');
// Another registered project, holding a helper of lead (#2514).
const OTHER = path.join('/work', 'annex');
const folder = (name: string) => path.join(PROJECT, '.clubhouse', 'agents', name);

const lead: Agent = { id: 'lead', projectId: 'p1', name: 'epic-lead', kind: 'durable', status: 'running', color: 'teal' };

function config(id: string, name: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name, color: 'teal', createdAt: '2026-10-18T09:00:00Z', parentAgentId: 'lead', ...extra };
}

function railAgent(id: string, name: string, status: Agent['status'], extra: Partial<Agent> = {}): Agent {
  return { id, projectId: 'p1', name, kind: 'durable', status, color: 'teal', ...extra };
}

let configs: DurableAgentConfig[];
/** Agents in OTHER. */
let otherConfigs: DurableAgentConfig[];
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
  otherConfigs = [];
  checks = {
    h1: { dirty: 3, unpushed: 2, unmerged: 2 },
    h2: { dirty: 0, unpushed: 0, unmerged: 0 },
  };
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: PROJECT }, { id: 'p2', name: 'annex', displayName: 'Annex', path: OTHER }], activeProjectId: 'p1' } as never);
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
  window.clubhouse.agent.listDurable = vi.fn(async (p: string) => (p === OTHER ? otherConfigs : configs)) as never;
  // Main's LIST_HELPERS: direct helpers in every project, each with its own project.
  window.clubhouse.agent.listHelpers = vi.fn(async (_p: string, id: string, _recursive?: boolean, includeDisposed?: boolean): Promise<HelperInProject[]> => [
    ...configs.map((config) => ({ projectId: 'p1', projectPath: PROJECT, config })),
    ...otherConfigs.map((config) => ({ projectId: 'p2', projectPath: OTHER, config })),
  ].filter((e) => e.config.parentAgentId === id && (includeDisposed || !isDisposedAgent(e.config)))) as never;
  window.clubhouse.agent.getDisposeChecks = vi.fn(async (_p: string, id: string) => checks[id] ?? { dirty: 0, unpushed: 0, unmerged: 0 });
  window.clubhouse.agent.disposeHelper = vi.fn(async (_p: string, id: string) => {
    configs = configs.map((c) => (c.id === id ? { ...c, disposedAt: '2026-10-18T12:00:00Z' } : c));
    otherConfigs = otherConfigs.map((c) => (c.id === id ? { ...c, disposedAt: '2026-10-18T12:00:00Z' } : c));
    return { ok: true, message: 'Disposed' };
  });
  window.clubhouse.agent.removeDisposed = vi.fn(async (_p: string, id: string) => {
    configs = configs.filter((c) => c.id !== id);
    otherConfigs = otherConfigs.filter((c) => c.id !== id);
    return { ok: true, message: 'Removed' };
  });
  window.clubhouse.agent.killAgent = vi.fn(async () => {});
});

afterEach(() => {
  useHelperStartRequestStore.setState({ requests: {} });
  useAgentStore.setState({ agents: {} } as never);
  useProjectStore.setState({ projects: [] });
});

function Harness({ orchestrating = true, agentOverride }: { orchestrating?: boolean; agentOverride?: Agent }) {
  const { helpers: list, reload } = useHelpersEverywhere(PROJECT, 'lead');
  const approvals = useHelperStartApprovals('lead', PROJECT, reload);
  const [open, setOpen] = useState(true);
  if (!list) return null;
  return (
    <HelpersCard
      agent={agentOverride ?? lead}
      projectPath={PROJECT}
      helpers={list}
      maxHelpers={5}
      orchestrating={orchestrating}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      approvals={approvals}
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
    expect(helpersSummary(4, 5, 1, 2)).toBe('4 of 5 · 1 starting · 2 waiting');
    expect(helpersSummary(0, 5, 0, 1)).toBe('1 waiting');
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

function startRequest(id: string, name: string, orchestratorId = 'lead'): HelperStartRequest {
  return {
    requestId: id, projectPath: PROJECT, orchestratorId, orchestratorName: 'epic-lead',
    args: { name, task: `Do the ${name} work` },
    createdAt: '2026-10-18T10:00:00.000Z', expiresAt: '2026-10-19T10:00:00.000Z',
  };
}

describe('Helpers card start approvals (#2234)', () => {
  beforeEach(() => {
    useHelperStartRequestStore.getState().add(startRequest('hstart_a', 'impl-api'));
    useHelperStartRequestStore.getState().add(startRequest('hstart_x', 'other', 'someone-else'));
  });

  it('shows the orchestrator\'s waiting starts as pending rows with Approve and Decline', async () => {
    await renderCard();
    expect(screen.getByTestId('details-card-helpers-summary')).toHaveTextContent('4 of 5 · 1 starting · 1 waiting');
    const row = screen.getByTestId('helper-request-hstart_a');
    expect(within(row).getByTestId('helper-state')).toHaveTextContent('Waiting for approval');
    expect(row).toHaveTextContent('impl-api');
    expect(row).toHaveTextContent('Do the impl-api work');
    expect(within(row).getByTestId('helper-approve')).toBeInTheDocument();
    expect(within(row).getByTestId('helper-decline')).toBeInTheDocument();
    expect(screen.queryByTestId('helper-request-hstart_x')).not.toBeInTheDocument();
  });

  it('approves through main with only the project and request id, then drops the row', async () => {
    window.clubhouse.agent.approveHelperStart = vi.fn(async () => ({ ok: true, message: 'Starting impl-api', helperId: 'h9' }));
    await renderCard();
    fireEvent.click(within(screen.getByTestId('helper-request-hstart_a')).getByTestId('helper-approve'));
    await waitFor(() => expect(screen.queryByTestId('helper-request-hstart_a')).not.toBeInTheDocument());
    expect(window.clubhouse.agent.approveHelperStart).toHaveBeenCalledWith(PROJECT, 'hstart_a');
    expect(useHelperStartRequestStore.getState().requests.hstart_a).toBeUndefined();
  });

  it('declines through main', async () => {
    window.clubhouse.agent.declineHelperStart = vi.fn(async () => ({ ok: true, message: 'Declined' }));
    await renderCard();
    fireEvent.click(within(screen.getByTestId('helper-request-hstart_a')).getByTestId('helper-decline'));
    await waitFor(() => expect(screen.queryByTestId('helper-request-hstart_a')).not.toBeInTheDocument());
    expect(window.clubhouse.agent.declineHelperStart).toHaveBeenCalledWith(PROJECT, 'hstart_a');
  });

  it('shows why an approved start was refused', async () => {
    window.clubhouse.agent.approveHelperStart = vi.fn(async () => ({ ok: false, message: 'Couldn’t start impl-api because this agent already has 5 of 5 helpers.' }));
    await renderCard();
    fireEvent.click(within(screen.getByTestId('helper-request-hstart_a')).getByTestId('helper-approve'));
    expect(await screen.findByTestId('helpers-error')).toHaveTextContent('5 of 5 helpers');
  });

  it('keeps Approve off until the orchestrator is running', async () => {
    window.clubhouse.agent.approveHelperStart = vi.fn(async () => ({ ok: true, message: 'Starting' }));
    render(<Harness agentOverride={{ ...lead, status: 'sleeping' }} />);
    const row = await screen.findByTestId('helper-request-hstart_a');
    expect(within(row).getByTestId('helper-approve-blocked')).toHaveTextContent('Wake epic-lead to approve');
    expect(within(row).getByTestId('helper-approve')).toBeDisabled();
    fireEvent.click(within(row).getByTestId('helper-approve'));
    expect(window.clubhouse.agent.approveHelperStart).not.toHaveBeenCalled();
    expect(within(row).getByTestId('helper-decline')).not.toBeDisabled();
  });

  it('lists waiting starts even before the first helper', async () => {
    configs = configs.filter((c) => c.parentAgentId !== 'lead');
    await renderCard();
    expect(screen.getByTestId('helper-request-hstart_a')).toBeInTheDocument();
    expect(screen.getByTestId('details-card-helpers')).not.toHaveTextContent('No helpers yet');
  });
});

describe('HelpersCard row text', () => {
  it('puts the whole work line in a tooltip, since it truncates', async () => {
    await renderCard();
    const h1 = screen.getByTestId('helper-row-h1');
    await waitFor(() => expect(within(h1).getByTestId('helper-work-line')).toHaveAttribute('title', 'impl-ipc/work · 3 uncommitted, 2 unpushed'));
  });

  it('says why a helper couldn’t start in words, with git’s output in the tooltip', async () => {
    const raw = "Command failed: git worktree add\nfatal: 'impl-docs/work' is already checked out";
    useAgentStore.setState((s) => ({ agents: { ...s.agents, h4: { ...s.agents.h4, errorMessage: raw } } }));
    await renderCard();
    const line = within(screen.getByTestId('helper-row-h4')).getByTestId('helper-work-line');
    expect(line).toHaveTextContent('couldn’t make its folder');
    expect(line).not.toHaveTextContent('fatal');
    expect(line.getAttribute('title')).toContain(raw);
  });
});

describe('HelpersCard stays current when the configs change', () => {
  let configListener: ((projectPath: string) => void) | null;

  beforeEach(() => {
    configListener = null;
    window.clubhouse.agent.onConfigsChanged = vi.fn((cb: (projectPath: string) => void) => {
      configListener = cb;
      return () => { configListener = null; };
    }) as never;
  });

  it('drops kept helpers once "Keep helpers as normal agents" clears their parent link', async () => {
    useAgentStore.setState((s) => ({
      agents: Object.fromEntries(Object.entries(s.agents).map(([id, a]) => [id, id === 'lead' ? a : { ...a, parentAgentId: 'lead' }])),
    }));
    await renderCard();
    expect(screen.getByTestId('helper-row-h1')).toBeInTheDocument();
    // Keep clears parentAgentId in agents.json; the rail reloads with it gone and no status change.
    configs = configs.map((c) => (c.parentAgentId === 'lead' ? { ...c, parentAgentId: undefined } : c));
    act(() => {
      useAgentStore.setState((s) => ({
        agents: Object.fromEntries(Object.entries(s.agents).map(([id, a]) => [id, { ...a, parentAgentId: undefined }])),
      }));
    });
    await waitFor(() => expect(screen.queryByTestId('helper-row-h1')).not.toBeInTheDocument());
    expect(screen.queryByTestId('helper-row-h2')).not.toBeInTheDocument();
  });

  it('re-reads when main says the project configs changed, such as a handoff', async () => {
    await renderCard();
    expect(screen.getByTestId('helper-row-h2')).toHaveAttribute('data-state', 'sleeping');
    configs = configs.map((c) => (c.id === 'h2' ? { ...c, handoff: { how: 'pushed', note: '', at: '2026-10-18T12:00:00Z' } } : c));
    act(() => configListener?.(`${PROJECT}${path.sep}`));
    await waitFor(() => expect(screen.getByTestId('helper-row-h2')).toHaveAttribute('data-state', 'handed-off'));
  });

  it('re-reads when another project changes, since a helper can be in any project (#2514)', async () => {
    await renderCard();
    expect(screen.queryByTestId('helper-row-x1')).not.toBeInTheDocument();
    otherConfigs = [config('x1', 'annex-ui')];
    act(() => configListener?.(OTHER));
    await waitFor(() => expect(screen.getByTestId('helper-row-x1')).toBeInTheDocument());
  });
});

describe('HelpersCard with a helper in another project (#2514)', () => {
  beforeEach(() => {
    otherConfigs = [
      { id: 'other-lead', name: 'annex-lead', color: 'teal', createdAt: '2026-10-18T09:00:00Z' },
      config('x1', 'annex-ui', { branch: 'annex-ui/work', worktreePath: path.join(OTHER, '.clubhouse', 'agents', 'annex-ui'), parentProjectPath: PROJECT }),
      config('x2', 'annex-old', { disposedAt: '2026-10-18T11:00:00Z', parentProjectPath: PROJECT }),
    ];
    useAgentStore.setState((s) => ({
      agents: { ...s.agents, x1: { ...railAgent('x1', 'annex-ui', 'running'), projectId: 'p2', parentAgentId: 'lead', parentProjectPath: PROJECT } },
    }));
  });

  it('lists it with its project as plain text, and leaves this project\'s rows unmarked', async () => {
    await renderCard();
    const x1 = screen.getByTestId('helper-row-x1');
    expect(within(x1).getByTestId('helper-project')).toHaveTextContent('in Annex');
    expect(within(screen.getByTestId('helper-row-h1')).queryByTestId('helper-project')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-helpers-summary')).toHaveTextContent('5 of 5 · 1 starting');
    await waitFor(() => expect(window.clubhouse.agent.getDisposeChecks).toHaveBeenCalledWith(OTHER, 'x1'));
    expect(window.clubhouse.agent.getDisposeChecks).not.toHaveBeenCalledWith(PROJECT, 'x1');
  });

  it('sleeps, wakes, opens and disposes it in its own project', async () => {
    const spawn = vi.fn(async () => 'x1');
    useAgentStore.setState({ spawnDurableAgent: spawn } as never);
    await renderCard();
    fireEvent.click(within(screen.getByTestId('helper-row-x1')).getByTestId('helper-sleep-wake'));
    await waitFor(() => expect(window.clubhouse.agent.killAgent).toHaveBeenCalledWith('x1', OTHER, undefined));

    act(() => {
      useAgentStore.setState((s) => ({ agents: { ...s.agents, x1: { ...s.agents.x1, status: 'sleeping' } } }));
    });
    const wake = await waitFor(() => {
      const button = within(screen.getByTestId('helper-row-x1')).getByTestId('helper-sleep-wake');
      expect(button).toHaveTextContent('Wake');
      return button;
    });
    fireEvent.click(wake);
    await waitFor(() => expect(spawn).toHaveBeenCalledWith('p2', OTHER, expect.objectContaining({ id: 'x1' }), false));

    fireEvent.click(within(screen.getByTestId('helper-row-x1')).getByTestId('helper-open'));
    expect(useAgentStore.getState().activeAgentId).toBe('x1');
    expect(useProjectStore.getState().activeProjectId).toBe('p2');

    fireEvent.click(within(screen.getByTestId('helper-row-x1')).getByTestId('helper-dispose'));
    await screen.findByTestId('dispose-helper-dialog');
    await waitFor(() => expect(screen.getByTestId('dispose-confirm')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('dispose-confirm'));
    await waitFor(() => expect(window.clubhouse.agent.disposeHelper).toHaveBeenCalledWith(OTHER, 'x1', undefined, expect.anything()));
  });

  it('removes a disposed helper from its own project', async () => {
    await renderCard();
    fireEvent.click(screen.getByTestId('helpers-disposed-toggle'));
    const row = screen.getByTestId('disposed-row-x2');
    expect(within(row).getByTestId('helper-project')).toHaveTextContent('in Annex');
    fireEvent.click(within(row).getByTestId('disposed-remove'));
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    await waitFor(() => expect(window.clubhouse.agent.removeDisposed).toHaveBeenCalledWith(OTHER, 'x2'));
  });
});
