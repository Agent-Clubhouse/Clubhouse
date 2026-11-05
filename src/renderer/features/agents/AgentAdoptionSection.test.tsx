import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivationDeliveryPreview, ActivationReceiptView, ActivationUiResult } from '../../../shared/managed-activation-ui';
import { AgentAdoptionSection } from './AgentAdoptionSection';
const api = window.clubhouse.agentSettings;
let receipt: ActivationReceiptView;
const props = { projectId: 'project-1', agentId: 'agent-1', compositionRevision: 1, hasDrafts: false };
const delivery = (): ActivationDeliveryPreview => ({ target: { projectId: 'project-1', agentId: 'agent-1' }, compositionRevision: 1, receiptRevision: 0,
  policy: { content: 'hold-preview', structure: 'accepted' }, deliveryToken: 'a'.repeat(64), instructions: 'Exact @@AgentName.\n\nRole text.', instructionLabel: 'Appended managed instructions',
  ambientContext: 'Ambient CLAUDE.md and provider instructions are additional context.', skillNames: ['clubhouse-agent-example:review'], cliVersion: '2.1.316' });
const choose = () => {
  fireEvent.change(screen.getByLabelText('Content revision policy'), { target: { value: 'hold-preview' } });
  fireEvent.change(screen.getByLabelText('Structure adoption policy'), { target: { value: 'accepted' } });
};
const preview = async () => { choose(); await waitFor(() => expect(screen.getByRole('button', { name: 'Preview saved delivery' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'Preview saved delivery' })); return screen.findByTestId('adoption-delivery-preview'); };
beforeEach(() => {
  receipt = { target: { projectId: 'project-1', agentId: 'agent-1' }, compositionRevision: 1, receiptRevision: 0, desiredGenerationId: null, materializedGenerationId: null, generations: [] };
  // Keep the mock bridge's discriminated result shape explicit.
  api.activationRead = vi.fn(async () => ({ ok: true, view: structuredClone(receipt) }));
  api.activationPreview = vi.fn(async () => ({ ok: true, view: delivery() }));
  api.activationAdopt = vi.fn(async () => {
    receipt.receiptRevision = 1; receipt.desiredGenerationId = 'generation-1';
    receipt.generations = [{ id: 'generation-1', compositionRevision: 1, preparedAt: '2026-11-05T00:00:00Z', skillNames: ['clubhouse-agent-example:review'], observations: [] }];
    return { ok: true, view: structuredClone(receipt) };
  });
  api.activationUnassign = vi.fn(async () => { receipt.desiredGenerationId = null; receipt.receiptRevision++; return { ok: true, view: structuredClone(receipt) }; });
});

describe('explicit next-start adoption UI', () => {
  it('leaves policies unset and never previews or wakes automatically', async () => {
    render(<AgentAdoptionSection {...props} />);
    await screen.findByText('No next-start snapshot is adopted. Retained files and history are not removed by unassignment.');
    expect(screen.getByLabelText('Content revision policy')).toHaveValue(''); expect(screen.getByLabelText('Structure adoption policy')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Preview saved delivery' })).toBeDisabled();
    expect(api.activationPreview).not.toHaveBeenCalled(); expect(api.activationAdopt).not.toHaveBeenCalled();
    expect(screen.getByText(/Adoption does not start or wake/)).toBeVisible();
  });
  it('reviews exact saved text, ambient context and namespaced skills before a separate adoption click', async () => {
    render(<AgentAdoptionSection {...props} />);
    expect((await preview()).textContent).toBe(delivery().instructions);
    expect(screen.getByText(delivery().ambientContext + ' Wildcards remain literal.')).toBeVisible();
    expect(screen.getByText('clubhouse-agent-example:review')).toBeVisible();
    expect(api.activationPreview).toHaveBeenCalledWith({ target: { projectId: 'project-1', agentId: 'agent-1' }, compositionRevision: 1, receiptRevision: 0, policy: { content: 'hold-preview', structure: 'accepted' } });
    expect(api.activationAdopt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Adopt snapshot for next fresh start' }));
    await screen.findByText(/Snapshot saved for the next supported fresh start/);
    expect(api.activationAdopt).toHaveBeenCalledWith({ target: { projectId: 'project-1', agentId: 'agent-1' }, compositionRevision: 1, receiptRevision: 0, policy: delivery().policy, deliveryToken: 'a'.repeat(64) });
    expect(screen.queryByTestId('adoption-delivery-preview')).not.toBeInTheDocument();
    expect(screen.getByText('Selected for next fresh start')).toBeVisible();
    expect(screen.getByText(/Snapshot retained at/)).toBeVisible();
    expect(screen.getByText('No private generation publication recorded')).toBeVisible();
    expect(screen.getByText('No start intent or process observation recorded')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });
  it.each(['drafts', 'saved revision', 'policy', 'target'] as const)('clears an outstanding delivery preview after %s changes', async (change) => {
    const view = render(<AgentAdoptionSection {...props} />); await preview();
    if (change === 'drafts') view.rerender(<AgentAdoptionSection {...props} hasDrafts />);
    if (change === 'saved revision') view.rerender(<AgentAdoptionSection {...props} compositionRevision={2} />);
    if (change === 'policy') fireEvent.change(screen.getByLabelText('Content revision policy'), { target: { value: 'takeable' } });
    if (change === 'target') view.rerender(<AgentAdoptionSection {...props} agentId="agent-2" />);
    expect(screen.queryByTestId('adoption-delivery-preview')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Adopt snapshot for next fresh start' })).not.toBeInTheDocument();
    if (change === 'target' || change === 'saved revision') { expect(screen.getByLabelText('Content revision policy')).toHaveValue(''); await act(async () => undefined); }
  });
  it('ignores a late preview from the previous target and never repopulates its bytes', async () => {
    let resolve!: (result: ActivationUiResult<ActivationDeliveryPreview>) => void;
    api.activationPreview = vi.fn(() => new Promise((done) => { resolve = done; }));
    const view = render(<AgentAdoptionSection {...props} />); choose();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview saved delivery' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview saved delivery' }));
    view.rerender(<AgentAdoptionSection {...props} agentId="agent-2" />);
    await act(async () => { resolve({ ok: true, view: delivery() }); });
    expect(screen.queryByText('Exact @@AgentName.')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Adopt snapshot for next fresh start' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Content revision policy')).toHaveValue('');
  });
  it('ignores late previews once unsaved drafts appear', async () => {
    let resolve!: (result: ActivationUiResult<ActivationDeliveryPreview>) => void;
    api.activationPreview = vi.fn(() => new Promise((done) => { resolve = done; }));
    const view = render(<AgentAdoptionSection {...props} />); choose();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview saved delivery' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'Preview saved delivery' }));
    view.rerender(<AgentAdoptionSection {...props} hasDrafts />);
    await act(async () => { resolve({ ok: true, view: delivery() }); });
    expect(screen.queryByTestId('adoption-delivery-preview')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Preview saved delivery' })).toBeDisabled();
  });
  it.each(['stale', 'failed'] as const)('shows %s adoption failures, clears approval and keeps the prior receipt', async (code) => {
    api.activationAdopt = vi.fn(async () => ({ ok: false, code }));
    render(<AgentAdoptionSection {...props} />); await preview(); fireEvent.click(screen.getByRole('button', { name: 'Adopt snapshot for next fresh start' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent(code === 'stale' ? 'review a new delivery preview' : 'Refresh before trying again');
    expect(screen.queryByTestId('adoption-delivery-preview')).not.toBeInTheDocument(); expect(screen.getByText(/No next-start snapshot is adopted/)).toBeVisible();
    expect(api.activationRead).toHaveBeenCalledTimes(2);
  });
  it('shows visible incompatibility and capability block reasons without exposing raw errors', async () => {
    api.activationPreview = vi.fn(async () => ({ ok: false, code: 'incompatible' }));
    render(<AgentAdoptionSection {...props} />); choose();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview saved delivery' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'Preview saved delivery' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing hooks, MCP'); expect(api.activationAdopt).not.toHaveBeenCalled();
    api.activationPreview = vi.fn(async () => { throw new Error('PRIVATE text /binary/path'); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview saved delivery' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'Preview saved delivery' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load or save adoption')); expect(screen.getByRole('alert')).not.toHaveTextContent('PRIVATE');
  });
  it('distinguishes retained desired/prepared/materialized/PTY observations and unassignment keeps history', async () => {
    receipt = { ...receipt, receiptRevision: 4, desiredGenerationId: 'new', materializedGenerationId: 'old', generations: [
      { id: 'old', compositionRevision: 1, preparedAt: 't1', materializedAt: 't2', skillNames: [], observations: [{ attemptId: 'attempt-1', intendedAt: 't3', startedAt: 't4', outcome: 'process_started_receipt_failed', cleanupRequested: true, cleanupConfirmed: false }] },
      { id: 'new', compositionRevision: 1, preparedAt: 't5', skillNames: [], observations: [] },
    ] };
    render(<AgentAdoptionSection {...props} />);
    expect(await screen.findByText('Private generation published at t2')).toBeVisible(); expect(screen.getByText(/receipt persistence failed/)).toHaveTextContent('exit unconfirmed');
    expect(screen.getByText('Selected for next fresh start')).toBeVisible(); expect(screen.getByText('Retained snapshot')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Remove future adoption' }));
    await screen.findByText(/Future adoption removed/);
    expect(api.activationUnassign).toHaveBeenCalledWith({ target: { projectId: 'project-1', agentId: 'agent-1' }, receiptRevision: 4 });
    expect(screen.getByText('Private generation published at t2')).toBeVisible();
  });
  it.each(['adopt', 'unassign', 'error'] as const)('ignores an older same-target receipt read after a newer %s operation', async (kind) => {
    const view = render(<AgentAdoptionSection {...props} />);
    await screen.findByText(/No next-start snapshot is adopted/);
    if (kind === 'unassign') { await preview(); fireEvent.click(screen.getByRole('button', { name: 'Adopt snapshot for next fresh start' })); await screen.findByText(/Snapshot saved for the next/); }
    let resolve!: (result: ActivationUiResult<ActivationReceiptView>) => void;
    const old = structuredClone(receipt);
    api.activationRead = vi.fn(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh receipts' }));
    if (kind === 'unassign') {
      fireEvent.click(screen.getByRole('button', { name: 'Remove future adoption' })); await screen.findByText(/Future adoption removed/);
    } else {
      await preview(); fireEvent.click(screen.getByRole('button', { name: 'Adopt snapshot for next fresh start' })); await screen.findByText(/Snapshot saved for the next/);
    }
    await act(async () => { resolve(kind === 'error' ? { ok: false, code: 'failed' } : { ok: true, view: old }); });
    if (kind === 'unassign') expect(screen.getByText(/No next-start snapshot is adopted/)).toBeVisible();
    else expect(screen.getByText('Selected for next fresh start')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); view.unmount();
  });
  it('accepts only the newest refresh and never regresses a receipt revision', async () => {
    render(<AgentAdoptionSection {...props} />); await screen.findByText(/No next-start snapshot is adopted/);
    const pending: Array<(result: ActivationUiResult<ActivationReceiptView>) => void> = [];
    api.activationRead = vi.fn(() => new Promise((done) => { pending.push(done); }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh receipts' })); fireEvent.click(screen.getByRole('button', { name: 'Refresh receipts' }));
    const newer = { ...structuredClone(receipt), receiptRevision: 2, desiredGenerationId: 'generation-1', generations: [{ id: 'generation-1', compositionRevision: 1, preparedAt: 't1', skillNames: [], observations: [] }] };
    await act(async () => { pending[1]({ ok: true, view: newer }); });
    await act(async () => { pending[0]({ ok: false, code: 'failed' }); });
    expect(screen.getByText('Selected for next fresh start')).toBeVisible(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh receipts' }));
    await act(async () => { pending[2]({ ok: true, view: { ...receipt, receiptRevision: 0 } }); });
    expect(screen.getByText('Selected for next fresh start')).toBeVisible();
  });

});
