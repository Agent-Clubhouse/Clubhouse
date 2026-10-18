import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, DurableAgentConfig, HelperCascadeResult } from '../../../../shared/types';
import type { OrchestrationPolicy, OrchestrationPolicyPatch, ResolvedOrchestrationPolicy } from '../../../../shared/orchestration-policy';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useAgentDetailsStore } from '../details/detailsStore';
import { AgentDetails } from '../details/AgentDetails';
import { OrchestrateCard, orchestrateSummary } from './OrchestrateCard';
import { useOrchestration } from './orchestration-hooks';

const PROJECT = path.join('/work', 'proj');

function resolved(p: OrchestrationPolicy): ResolvedOrchestrationPolicy {
  return { ...p, sources: { orchestrate: 'agent', access: 'default', control: 'default', maxHelpers: 'default' } };
}

const lead: Agent = {
  id: 'lead', projectId: 'p1', name: 'epic-lead', kind: 'durable', status: 'sleeping', color: 'teal', orchestrator: 'claude-code',
  worktreePath: path.join(PROJECT, '.clubhouse', 'agents', 'epic-lead'),
};

let stored: OrchestrationPolicy;
let helperIds: string[];
let configs: DurableAgentConfig[];

function config(id: string, name: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name, color: 'teal', createdAt: '2026-10-18T09:00:00Z', ...extra };
}

beforeEach(() => {
  stored = { orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5 };
  helperIds = [];
  configs = [config('lead', 'epic-lead')];
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: PROJECT }] as never });
  useAgentStore.setState({ agents: { lead } } as never);
  useAgentDetailsStore.setState({ open: true, focus: null });
  window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: false, files: [] }));
  window.clubhouse.agent.listDurable = vi.fn(async () => configs) as never;
  window.clubhouse.agent.getOrchestrationPolicy = vi.fn(async () => resolved(stored));
  window.clubhouse.agent.resolveHelperAccess = vi.fn(async () => ({ freeAgentMode: true, permissionMode: 'auto' as const, level: 'auto' as const, ceiling: 'auto' as const, clamped: false }));
  window.clubhouse.app.getOrchestrationSettings = vi.fn(async () => ({ globalHelperCap: 8 }));
  window.clubhouse.agent.setOrchestrationPolicy = vi.fn(async (_p: string, _id: string, patch: OrchestrationPolicyPatch) => {
    if (patch.orchestrate === false && helperIds.length > 0) {
      return { ok: true, message: 'Choose', needsHelperChoice: { helperIds } };
    }
    stored = { ...stored, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null)) } as OrchestrationPolicy;
    return { ok: true, message: 'Saved', policy: resolved(stored) };
  });
  window.clubhouse.agent.turnOffOrchestration = vi.fn(async () => ({ ok: true, message: 'Cancelled', cancelled: true }));
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
  useAgentStore.setState({ agents: {} } as never);
});

function Harness({ agent = lead }: { agent?: Agent }) {
  const orch = useOrchestration(PROJECT, agent);
  const [open, setOpen] = useState(true);
  return <OrchestrateCard agent={agent} projectPath={PROJECT} orch={orch} open={open} onToggle={() => setOpen((o) => !o)} />;
}

async function renderCard(agent?: Agent) {
  render(<Harness agent={agent} />);
  return await screen.findByTestId('orchestrate-toggle');
}

describe('orchestrateSummary', () => {
  it('answers in one line', () => {
    expect(orchestrateSummary({ policy: null })).toBe('');
    expect(orchestrateSummary({ policy: resolved({ orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5 }) })).toBe('off');
    expect(orchestrateSummary({ policy: resolved({ orchestrate: true, access: 'same', control: 'ask-before-start', maxHelpers: 3 }) })).toBe('ask before starting · up to 3');
  });
});

describe('Orchestrate card (#2232)', () => {
  it('turns orchestration on for a sleeping agent and says when the tools appear', async () => {
    const toggle = await renderCard();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(window.clubhouse.agent.setOrchestrationPolicy).toHaveBeenCalledWith(PROJECT, 'lead', { orchestrate: true });
    expect(screen.getByTestId('orchestrate-note')).toHaveTextContent('Saved. The helper tools appear the next time epic-lead starts.');
    expect(screen.getByTestId('orchestrate-access')).toBeInTheDocument();
  });

  it('says nothing about a next start when the agent is running', async () => {
    const toggle = await renderCard({ ...lead, status: 'running' });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.queryByTestId('orchestrate-note')).not.toBeInTheDocument();
  });

  it('saves access and control, and shows the live ceiling', async () => {
    stored.orchestrate = true;
    await renderCard({ ...lead, status: 'running' });
    const access = await screen.findByTestId('orchestrate-access') as HTMLSelectElement;
    await waitFor(() => expect(screen.getByTestId('orchestrate-access-note')).toHaveTextContent('At most Auto, epic-lead’s level now.'));
    // Full access is above the ceiling while the orchestrator runs at Auto.
    expect(within(access).getByRole('option', { name: 'Full access' })).toBeDisabled();
    expect(within(access).getByRole('option', { name: 'Same as epic-lead' })).not.toBeDisabled();

    fireEvent.change(access, { target: { value: 'standard' } });
    await waitFor(() => expect(window.clubhouse.agent.setOrchestrationPolicy).toHaveBeenLastCalledWith(PROJECT, 'lead', { access: 'standard' }));

    fireEvent.change(screen.getByTestId('orchestrate-control'), { target: { value: 'ask-everything' } });
    await waitFor(() => expect(window.clubhouse.agent.setOrchestrationPolicy).toHaveBeenLastCalledWith(PROJECT, 'lead', { control: 'ask-everything' }));
    expect(screen.getByTestId('details-card-orchestrate-summary')).toHaveTextContent('ask for everything · up to 5');
  });

  it('explains a clamped level', async () => {
    stored = { ...stored, orchestrate: true, access: 'bypass' };
    window.clubhouse.agent.resolveHelperAccess = vi.fn(async () => ({ freeAgentMode: false, permissionMode: 'auto' as const, level: 'standard' as const, ceiling: 'standard' as const, clamped: true }));
    await renderCard({ ...lead, status: 'running' });
    await waitFor(() => expect(screen.getByTestId('orchestrate-access-note')).toHaveTextContent('epic-lead runs at Ask first now, so helpers get Ask first.'));
    // The saved value still shows, even above the ceiling.
    expect((screen.getByTestId('orchestrate-access') as HTMLSelectElement).value).toBe('bypass');
  });

  it('keeps helpers at once between 1 and the app-wide cap', async () => {
    stored.orchestrate = true;
    await renderCard();
    const input = await screen.findByTestId('orchestrate-max-helpers') as HTMLInputElement;
    await waitFor(() => expect(screen.getByTestId('orchestrate-max-helpers-note')).toHaveTextContent('Up to 8, the app-wide limit'));

    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('orchestrate-max-helpers-note')).toHaveTextContent('Enter a whole number from 1 to 8.');
    expect(window.clubhouse.agent.setOrchestrationPolicy).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.clubhouse.agent.setOrchestrationPolicy).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(window.clubhouse.agent.setOrchestrationPolicy).toHaveBeenCalledWith(PROJECT, 'lead', { maxHelpers: 3 }));
    expect(screen.getByTestId('orchestrate-max-helpers-note')).toHaveTextContent('Up to 8');
  });

  it('shows a failed save and keeps the saved value', async () => {
    stored.orchestrate = true;
    window.clubhouse.agent.setOrchestrationPolicy = vi.fn(async () => ({ ok: false, message: 'Orchestration policy is locked' }));
    await renderCard();
    fireEvent.change(await screen.findByTestId('orchestrate-control'), { target: { value: 'ask-everything' } });
    expect(await screen.findByTestId('orchestrate-error')).toHaveTextContent('Orchestration policy is locked');
    expect(screen.getByTestId('details-card-orchestrate-summary')).toHaveTextContent('hands-off');
  });

  it('turns off at once when there are no helpers', async () => {
    stored.orchestrate = true;
    const toggle = await renderCard();
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByTestId('turn-off-orchestration')).not.toBeInTheDocument();
  });
});

describe('Turning orchestration off with helpers (#2232)', () => {
  beforeEach(() => {
    stored.orchestrate = true;
    helperIds = ['h1', 'h2'];
    configs = [
      config('lead', 'epic-lead'),
      config('h1', 'impl-ipc', { parentAgentId: 'lead' }),
      config('h2', 'merge-1', { parentAgentId: 'lead' }),
    ];
    useAgentStore.setState({
      agents: {
        lead,
        h1: { id: 'h1', projectId: 'p1', name: 'impl-ipc', kind: 'durable', status: 'running', color: 'teal' },
        h2: { id: 'h2', projectId: 'p1', name: 'merge-1', kind: 'durable', status: 'sleeping', color: 'teal' },
      },
    } as never);
  });

  /** Main marks disposed helpers; the rail drops them on its next load. */
  function dispose(...ids: string[]) {
    configs = configs.map((c) => (ids.includes(c.id) ? { ...c, disposedAt: '2026-10-18T12:00:00Z' } : c));
  }

  async function openDialog() {
    const toggle = await renderCard();
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId('turn-off-orchestration');
    return { toggle, dialog };
  }

  it('warns first, naming the helpers and what each is doing', async () => {
    const { toggle, dialog } = await openDialog();
    expect(dialog).toHaveTextContent('epic-lead has 2 helpers.');
    const list = await within(dialog).findByTestId('turn-off-helpers');
    expect(list).toHaveTextContent('impl-ipc');
    expect(list).toHaveTextContent('running');
    expect(list).toHaveTextContent('merge-1');
    expect(list).toHaveTextContent('sleeping');
    // Nothing changed yet.
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('cancel leaves everything as it was', async () => {
    const { toggle } = await openDialog();
    fireEvent.click(screen.getByTestId('turn-off-cancel'));
    await waitFor(() => expect(screen.queryByTestId('turn-off-orchestration')).not.toBeInTheDocument());
    expect(window.clubhouse.agent.turnOffOrchestration).toHaveBeenCalledWith(PROJECT, 'lead', 'cancel');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the helpers as normal agents', async () => {
    window.clubhouse.agent.turnOffOrchestration = vi.fn(async () => ({
      ok: true, message: 'Kept 2 helper(s)', helperIds: ['h1', 'h2'], policy: resolved({ ...stored, orchestrate: false }),
    }));
    const { toggle } = await openDialog();
    fireEvent.click(screen.getByTestId('turn-off-keep'));
    await waitFor(() => expect(screen.queryByTestId('turn-off-orchestration')).not.toBeInTheDocument());
    expect(window.clubhouse.agent.turnOffOrchestration).toHaveBeenCalledWith(PROJECT, 'lead', 'keep', undefined);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // Kept helpers stay in the rail.
    expect(useAgentStore.getState().agents.h1).toBeDefined();
  });

  it('disposes the helpers when nothing would be lost', async () => {
    window.clubhouse.agent.turnOffOrchestration = vi.fn(async () => {
      dispose('h1', 'h2');
      return { ok: true, message: 'Disposed 2 helper(s)', helperIds: ['h1', 'h2'], policy: resolved({ ...stored, orchestrate: false }) };
    });
    const { toggle } = await openDialog();
    fireEvent.click(screen.getByTestId('turn-off-dispose'));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(window.clubhouse.agent.turnOffOrchestration).toHaveBeenCalledWith(PROJECT, 'lead', 'dispose', undefined);
    expect(useAgentStore.getState().agents.h1).toBeUndefined();
    expect(useAgentStore.getState().agents.h2).toBeUndefined();
  });

  it('shows the work at risk and offers Dispose anyway', async () => {
    const blocked: HelperCascadeResult = {
      ok: false,
      message: 'impl-ipc has work that disposing would lose, or couldn\'t be checked',
      blocked: [{ agentId: 'h1', name: 'impl-ipc', checks: { dirty: 3, unpushed: 2, unmerged: 2 } }],
    };
    window.clubhouse.agent.turnOffOrchestration = vi.fn(async (_p: string, _id: string, _c: string, force?: boolean) => {
      if (!force) return blocked;
      dispose('h1', 'h2');
      return { ok: true, message: 'Disposed 2 helper(s)', helperIds: ['h1', 'h2'], policy: resolved({ ...stored, orchestrate: false }) };
    });
    const { toggle } = await openDialog();
    fireEvent.click(screen.getByTestId('turn-off-dispose'));
    const list = await screen.findByTestId('turn-off-blocked');
    expect(list).toHaveTextContent('impl-ipc');
    expect(list).toHaveTextContent('3 files not committed');
    expect(list).toHaveTextContent('2 commits not pushed');
    // Not merged is information only, not a reason to block.
    expect(list).not.toHaveTextContent('not merged');
    expect(screen.getByTestId('turn-off-blocked-note')).toHaveTextContent('Dispose anyway deletes this work');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByTestId('turn-off-force'));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(window.clubhouse.agent.turnOffOrchestration).toHaveBeenLastCalledWith(PROJECT, 'lead', 'dispose', true);
  });

  it('never offers force for a helper that couldn\'t be checked', async () => {
    window.clubhouse.agent.turnOffOrchestration = vi.fn(async () => ({
      ok: false,
      message: 'merge-1 has work that disposing would lose, or couldn\'t be checked',
      blocked: [
        { agentId: 'h1', name: 'impl-ipc', checks: { dirty: 1, unpushed: 0, unmerged: 0 } },
        { agentId: 'h2', name: 'merge-1', checks: { dirty: 0, unpushed: 0, unmerged: null, error: 'couldn\'t check, its remote has never been fetched' } },
      ],
    }));
    await openDialog();
    fireEvent.click(screen.getByTestId('turn-off-dispose'));
    const list = await screen.findByTestId('turn-off-blocked');
    expect(list).toHaveTextContent('Couldn’t be checked (couldn\'t check, its remote has never been fetched)');
    expect(screen.queryByTestId('turn-off-force')).not.toBeInTheDocument();
    expect(screen.getByTestId('turn-off-blocked-note')).toHaveTextContent('A helper that couldn’t be checked can’t be disposed');
    // Keep is still there.
    expect(screen.getByTestId('turn-off-keep')).toBeInTheDocument();
  });

  it('reports a failure without closing', async () => {
    window.clubhouse.agent.turnOffOrchestration = vi.fn(async () => {
      dispose('h2');
      return { ok: false, message: 'Disposed 1 of 2 helpers', helperIds: ['h2'], failed: [{ agentId: 'h1', name: 'impl-ipc', reason: 'EBUSY' }] };
    });
    await openDialog();
    fireEvent.click(screen.getByTestId('turn-off-dispose'));
    expect(await screen.findByTestId('turn-off-error')).toHaveTextContent('Disposed 1 of 2 helpers. impl-ipc (EBUSY) couldn’t be disposed.');
    // The one that went leaves the rail; the other stays.
    expect(useAgentStore.getState().agents.h2).toBeUndefined();
    expect(useAgentStore.getState().agents.h1).toBeDefined();
  });
  it('treats a failed dispose that still turned orchestration off as off', async () => {
    window.clubhouse.agent.turnOffOrchestration = vi.fn(async () => {
      dispose('h2');
      return {
        ok: false,
        message: 'Disposed 1 of 2 helpers',
        helperIds: ['h2'],
        failed: [{ agentId: 'h1', name: 'impl-ipc', reason: 'EBUSY' }],
        policy: resolved({ ...stored, orchestrate: false }),
      };
    });
    const { toggle } = await openDialog();
    fireEvent.click(screen.getByTestId('turn-off-dispose'));
    expect(await screen.findByTestId('turn-off-partial')).toHaveTextContent(
      'Orchestration is off, but impl-ipc (EBUSY) couldn’t be settled and stays as it was.',
    );
    fireEvent.click(screen.getByTestId('turn-off-close'));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByTestId('turn-off-orchestration')).not.toBeInTheDocument();
    expect(useAgentStore.getState().agents.h2).toBeUndefined();
  });
});

describe('Orchestration cards in Agent details', () => {
  it('shows Orchestrate for a top-level agent, and Helpers and Connections once it orchestrates', async () => {
    stored.orchestrate = true;
    configs = [config('lead', 'epic-lead'), config('h1', 'impl-ipc', { parentAgentId: 'lead', branch: 'impl-ipc/work' })];
    render(<AgentDetails agent={lead} />);
    expect(await screen.findByTestId('details-card-orchestrate')).toBeInTheDocument();
    expect(await screen.findByTestId('details-card-helpers')).toBeInTheDocument();
    expect(screen.getByTestId('details-card-helpers-summary')).toHaveTextContent('1 of 5');
    expect(screen.getByTestId('details-card-connections')).toBeInTheDocument();
  });

  it('leaves the orchestration cards out for a helper and for an agent that doesn\'t orchestrate', async () => {
    configs = [config('lead', 'epic-lead', { parentAgentId: 'boss' })];
    render(<AgentDetails agent={lead} />);
    await screen.findByTestId('details-card-session');
    await waitFor(() => expect(window.clubhouse.agent.listDurable).toHaveBeenCalled());
    expect(screen.queryByTestId('details-card-orchestrate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-card-helpers')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-card-connections')).not.toBeInTheDocument();
  });
});
