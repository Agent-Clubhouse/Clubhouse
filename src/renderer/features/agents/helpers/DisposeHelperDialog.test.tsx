import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, HelperDisposeChecks } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { DisposeHelperDialog, type DisposeHelperTarget } from './DisposeHelperDialog';

const PROJECT = path.join('/work', 'proj');
const helper: DisposeHelperTarget = {
  id: 'h1', name: 'impl-ipc', projectId: 'p1', worktreePath: path.join(PROJECT, '.clubhouse', 'agents', 'impl-ipc'), status: 'sleeping',
};

let checks: HelperDisposeChecks;
let order: string[];

function setRail(status: Agent['status']) {
  useAgentStore.setState({ agents: { h1: { id: 'h1', projectId: 'p1', name: 'impl-ipc', kind: 'durable', status, color: 'teal' } } } as never);
}

beforeEach(() => {
  checks = { dirty: 0, unpushed: 0, unmerged: 0 };
  order = [];
  setRail('sleeping');
  window.clubhouse.agent.getDisposeChecks = vi.fn(async () => checks);
  window.clubhouse.agent.killAgent = vi.fn(async () => { order.push('kill'); });
  window.clubhouse.agent.disposeHelper = vi.fn(async () => { order.push('dispose'); return { ok: true, message: 'Disposed' }; });
  window.clubhouse.agent.reportDisposeDecision = vi.fn(async () => true);
});

afterEach(() => {
  useAgentStore.setState({ agents: {} } as never);
});

function renderDialog(props: Partial<Parameters<typeof DisposeHelperDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onDisposed = vi.fn();
  const onDeclined = vi.fn();
  render(<DisposeHelperDialog helper={helper} projectPath={PROJECT} onClose={onClose} onDisposed={onDisposed} onDeclined={onDeclined} {...props} />);
  return { onClose, onDisposed, onDeclined };
}

describe('Dispose helper dialog (#2232)', () => {
  it('disposes a clean helper with Dispose as the main action', async () => {
    const { onClose, onDisposed } = renderDialog();
    const dialog = screen.getByTestId('dispose-helper-dialog');
    expect(dialog).toHaveTextContent('Dispose of impl-ipc?');
    expect(dialog).toHaveTextContent(path.join('.clubhouse', 'agents', 'impl-ipc'));
    const list = await screen.findByTestId('dispose-checks');
    expect(list).toHaveTextContent('No uncommitted files');
    expect(list).toHaveTextContent('Merged into the base branch');
    const confirm = screen.getByTestId('dispose-confirm');
    expect(confirm).toHaveTextContent(/^Dispose$/);
    // Asleep: nothing to stop, so no Just sleep.
    expect(screen.queryByTestId('dispose-sleep')).not.toBeInTheDocument();

    fireEvent.click(confirm);
    await waitFor(() => expect(onDisposed).toHaveBeenCalled());
    // What the user saw goes with it, so main can tell if more is at risk after a stop.
    expect(window.clubhouse.agent.disposeHelper).toHaveBeenCalledWith(PROJECT, 'h1', undefined, { dirty: 0, unpushed: 0, unmerged: 0 });
    expect(window.clubhouse.agent.killAgent).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(useAgentStore.getState().agents.h1).toBeUndefined();
  });

  it('leaves stopping a running helper to main', async () => {
    setRail('running');
    renderDialog();
    await screen.findByTestId('dispose-checks');
    expect(screen.getByTestId('dispose-sleep')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dispose-confirm'));
    await waitFor(() => expect(order).toEqual(['dispose']));
    expect(window.clubhouse.agent.killAgent).not.toHaveBeenCalled();
  });

  it('shows the new list and asks again when more is at risk after the stop', async () => {
    checks = { dirty: 1, unpushed: 0, unmerged: 0 };
    window.clubhouse.agent.disposeHelper = vi.fn(async () => ({
      ok: false, changed: true, stopped: true, message: 'impl-ipc saved more work before it stopped', checks: { dirty: 1, unpushed: 3, unmerged: 3 },
    }));
    const { onClose } = renderDialog();
    await screen.findByTestId('dispose-checks');
    fireEvent.click(screen.getByTestId('dispose-confirm'));
    expect(await screen.findByTestId('dispose-error')).toHaveTextContent(
      'impl-ipc saved more work before it stopped. Review what would be lost and confirm again. impl-ipc is stopped.',
    );
    expect(screen.getByTestId('dispose-checks')).toHaveTextContent('3 commits not pushed');
    expect(window.clubhouse.agent.disposeHelper).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // Confirming again sends the new list as what the user saw.
    fireEvent.click(screen.getByTestId('dispose-confirm'));
    await waitFor(() => expect(window.clubhouse.agent.disposeHelper).toHaveBeenLastCalledWith(PROJECT, 'h1', true, { dirty: 1, unpushed: 3, unmerged: 3 }));
  });

  it('lists work at risk and forces only with Dispose anyway', async () => {
    checks = { dirty: 3, unpushed: 2, unmerged: 4 };
    renderDialog();
    const list = await screen.findByTestId('dispose-checks');
    const lines = within(list).getAllByRole('listitem');
    expect(lines[0]).toHaveTextContent('3 files not committed');
    expect(lines[0]).toHaveAttribute('data-check', 'risk');
    expect(lines[1]).toHaveTextContent('2 commits not pushed');
    expect(list).toHaveTextContent('4 commits not merged into the base branch');
    expect(screen.getByTestId('dispose-risk-note')).toHaveTextContent('Dispose anyway deletes this work');
    const confirm = screen.getByTestId('dispose-confirm');
    expect(confirm).toHaveTextContent('Dispose anyway');
    fireEvent.click(confirm);
    await waitFor(() => expect(window.clubhouse.agent.disposeHelper).toHaveBeenCalledWith(PROJECT, 'h1', true, { dirty: 3, unpushed: 2, unmerged: 4 }));
  });

  it('never offers force when a check couldn\'t run', async () => {
    checks = { dirty: 0, unpushed: 0, unmerged: null, error: 'couldn\'t check, its remote has never been fetched' };
    renderDialog();
    const list = await screen.findByTestId('dispose-checks');
    expect(list).toHaveTextContent('Couldn’t be checked (couldn\'t check, its remote has never been fetched)');
    expect(screen.queryByTestId('dispose-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('dispose-blocked-note')).toBeInTheDocument();

    // Check again runs the checks once more; once they pass, Dispose is back.
    checks = { dirty: 0, unpushed: 0, unmerged: 0 };
    fireEvent.click(screen.getByTestId('dispose-recheck'));
    await waitFor(() => expect(screen.getByTestId('dispose-confirm')).toHaveTextContent(/^Dispose$/));
    expect(window.clubhouse.agent.getDisposeChecks).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog open with main\'s reason when main refuses', async () => {
    window.clubhouse.agent.disposeHelper = vi.fn(async () => ({
      ok: false, message: 'impl-ipc has work that disposing would lose', checks: { dirty: 1, unpushed: 0, unmerged: 0 },
    }));
    const { onClose } = renderDialog();
    await screen.findByTestId('dispose-checks');
    fireEvent.click(screen.getByTestId('dispose-confirm'));
    expect(await screen.findByTestId('dispose-error')).toHaveTextContent('impl-ipc has work that disposing would lose. Nothing was deleted.');
    expect(screen.getByTestId('dispose-checks')).toHaveTextContent('1 file not committed');
    expect(screen.getByTestId('dispose-confirm')).toHaveTextContent('Dispose anyway');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Just sleep stops the helper and keeps everything', async () => {
    setRail('running');
    const { onClose } = renderDialog();
    await screen.findByTestId('dispose-checks');
    fireEvent.click(screen.getByTestId('dispose-sleep'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(window.clubhouse.agent.killAgent).toHaveBeenCalled();
    expect(window.clubhouse.agent.disposeHelper).not.toHaveBeenCalled();
  });

  it('answers an orchestrator\'s request with Decline (#2251)', async () => {
    checks = { dirty: 2, unpushed: 0, unmerged: 0 };
    const { onDeclined, onClose } = renderDialog({ requestedBy: 'epic-lead' });
    expect(await screen.findByTestId('dispose-checks')).toBeInTheDocument();
    expect(screen.getByTestId('dispose-helper-dialog')).toHaveTextContent('epic-lead asked to dispose of impl-ipc, but it has work that would be lost.');
    fireEvent.click(screen.getByTestId('dispose-cancel'));
    expect(screen.getByTestId('dispose-cancel')).toHaveTextContent('Decline');
    expect(onDeclined).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Dispose requests from Needs you (#2229)', () => {
  it('opens the confirmation for the request being reviewed and dismisses it on decline', async () => {
    const { useHelperDisposeRequestStore } = await import('../../../stores/helperDisposeRequestStore');
    const { HelperDisposeRequestDialog } = await import('./HelperDisposeRequestDialog');
    useHelperDisposeRequestStore.setState({ requests: {}, reviewing: null });
    useHelperDisposeRequestStore.getState().add({
      projectPath: PROJECT, orchestratorId: 'lead', helperId: 'h1', helperName: 'impl-ipc', checks: { dirty: 0, unpushed: 0, unmerged: 0 }, forceRequested: false,
    }, 'epic-lead');
    render(<HelperDisposeRequestDialog />);
    expect(screen.queryByTestId('dispose-helper-dialog')).not.toBeInTheDocument();

    act(() => { useHelperDisposeRequestStore.getState().review('h1'); });
    const dialog = await screen.findByTestId('dispose-helper-dialog');
    expect(dialog).toHaveTextContent('epic-lead asked to dispose of impl-ipc.');
    await screen.findByTestId('dispose-checks');
    fireEvent.click(screen.getByTestId('dispose-cancel'));
    await waitFor(() => expect(screen.queryByTestId('dispose-helper-dialog')).not.toBeInTheDocument());
    expect(useHelperDisposeRequestStore.getState().requests).toEqual({});
    expect(window.clubhouse.agent.disposeHelper).not.toHaveBeenCalled();
    // The orchestrator hears the answer.
    await waitFor(() => expect(window.clubhouse.agent.reportDisposeDecision).toHaveBeenCalledWith('lead', 'impl-ipc', 'declined'));
  });

  it('disposes on accept and clears the request', async () => {
    const { useHelperDisposeRequestStore } = await import('../../../stores/helperDisposeRequestStore');
    const { HelperDisposeRequestDialog } = await import('./HelperDisposeRequestDialog');
    useHelperDisposeRequestStore.setState({ requests: {}, reviewing: null });
    useHelperDisposeRequestStore.getState().add({
      projectPath: PROJECT, orchestratorId: 'lead', helperId: 'h1', helperName: 'impl-ipc', checks: { dirty: 0, unpushed: 0, unmerged: 0 }, forceRequested: false,
    }, 'epic-lead');
    useHelperDisposeRequestStore.getState().review('h1');
    render(<HelperDisposeRequestDialog />);
    await screen.findByTestId('dispose-checks');
    fireEvent.click(screen.getByTestId('dispose-confirm'));
    await waitFor(() => expect(window.clubhouse.agent.disposeHelper).toHaveBeenCalledWith(PROJECT, 'h1', undefined, { dirty: 0, unpushed: 0, unmerged: 0 }));
    await waitFor(() => expect(useHelperDisposeRequestStore.getState().requests).toEqual({}));
    await waitFor(() => expect(window.clubhouse.agent.reportDisposeDecision).toHaveBeenCalledWith('lead', 'impl-ipc', 'disposed'));
  });
});
