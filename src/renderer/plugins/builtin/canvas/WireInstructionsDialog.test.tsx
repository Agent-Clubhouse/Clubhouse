import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { WireInstructionsDialog } from './WireInstructionsDialog';
import { ConnectionSourcesDialog } from '../../../features/agents/helpers/ConnectionSourcesDialog';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useAgentStore } from '../../../stores/agentStore';
import type { ConnectionGuidanceSnapshot } from '../../../../shared/connection-guidance';

const binding: McpBindingEntry = { agentId: 'a', targetId: 'b', targetKind: 'agent', label: 'B' };
const snapshot = (agentId: string, targetId: string, changes: Partial<ConnectionGuidanceSnapshot> = {}): ConnectionGuidanceSnapshot => ({
  agentId, targetId, instructions: { '*': `${agentId} default`, absent_tool: 'Retain me' },
  hasOverride: false, sources: [], unreadable: [], conflictingSources: false,
  needsSourceConfirmation: false, readOnly: false, revision: `${agentId}-r1`, ...changes,
});
const pairs = [
  { agentId: 'a', targetId: 'b', bound: true, sources: [] },
  { agentId: 'b', targetId: 'a', bound: true, sources: [] },
];

beforeEach(() => {
  useMcpBindingStore.setState({ bindings: [binding, { ...binding, agentId: 'b', targetId: 'a', label: 'A' }] });
  useAgentStore.setState({ agents: {} });
  window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({ pairs, unreadable: [] }));
  window.clubhouse.mcpBinding.getConnectionGrants = vi.fn(async () => []);
  window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => snapshot(from, to));
  window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({
    state: 'available', tools: [{ suffix: 'real_registered_tool', description: 'Actual base', available: true }],
  }));
  window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn(async (from, to, request) => snapshot(from, to, {
    instructions: request.instructions, revision: `${from}-r2`, hasOverride: true,
  }));
  window.clubhouse.mcpBinding.previewConnectionGuidance = vi.fn(async () => ({ real_registered_tool: 'Actual sanitized scoped description' }));
});

describe('shared Canvas and card guidance editor', () => {
  it('uses the real catalog, retains absent overrides and saves only the chosen direction', async () => {
    const onClose = vi.fn();
    const view = render(<WireInstructionsDialog binding={binding} onClose={onClose} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    expect(textarea).toHaveValue('a default');
    const select = view.getByLabelText('Apply guidance to');
    expect(view.getByRole('option', { name: 'real_registered_tool' })).toBeInTheDocument();
    expect(view.getByRole('option', { name: 'absent_tool (saved; unavailable)' })).toBeInTheDocument();
    expect(view.queryByRole('option', { name: 'send_message' })).toBeNull();
    fireEvent.change(select, { target: { value: 'real_registered_tool' } });
    fireEvent.change(textarea, { target: { value: 'Replace default for this tool' } });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledExactlyOnceWith('a', 'b', {
      instructions: { '*': 'a default', absent_tool: 'Retain me', real_registered_tool: 'Replace default for this tool' },
      revision: 'a-r1', replaceAcrossSources: false,
    });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'B to a' }));
    expect(textarea).toHaveValue('b default');
  });

  it('copies to the reverse draft only after an explicit action and still requires a separate save', async () => {
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    await waitFor(() => expect(view.getByRole('button', { name: 'Copy guidance to reverse draft' })).toBeEnabled());
    fireEvent.change(textarea, { target: { value: 'Explicit reverse copy' } });
    fireEvent.click(view.getByRole('button', { name: 'Copy guidance to reverse draft' }));
    expect(view.getByRole('status')).toHaveTextContent('reverse draft only');
    expect(textarea).toHaveValue('Explicit reverse copy');
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledExactlyOnceWith('b', 'a', {
      instructions: { '*': 'Explicit reverse copy', absent_tool: 'Retain me' }, revision: 'b-r1', replaceAcrossSources: false,
    });
  });

  it('keeps the dialog and draft while saving, reports failure and refreshes revisions without discarding the draft', async () => {
    let reject!: (error: Error) => void;
    window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onClose = vi.fn();
    const view = render(<WireInstructionsDialog binding={binding} onClose={onClose} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    fireEvent.change(textarea, { target: { value: 'Keep my draft' } });
    fireEvent.click(view.getByRole('button', { name: 'Save direction' }));
    expect(view.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error('Source changed. Reload before saving.')));
    expect(view.getByRole('alert')).toHaveTextContent('Your draft is still here');
    expect(textarea).toHaveValue('Keep my draft');
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => snapshot(from, to, { revision: 'fresh' }));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Reload sources and keep draft' })); });
    expect(textarea).toHaveValue('Keep my draft');
    window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn(async (from, to, request) => snapshot(from, to, { instructions: request.instructions }));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledWith('a', 'b', expect.objectContaining({ revision: 'fresh', instructions: expect.objectContaining({ '*': 'Keep my draft' }) }));
  });

  it('requires explicit source confirmation on the card and previews backend descriptions without rewriting originals', async () => {
    const originals = [
      { sourceId: 'canvas-wires', label: 'Home', instructions: { '*': 'Original one' } },
      { sourceId: 'canvas-wires', label: 'Project', instructions: { '*': 'Original two' } },
    ];
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => snapshot(from, to, {
      sources: originals, conflictingSources: true, needsSourceConfirmation: true,
    }));
    const view = render(<ConnectionSourcesDialog agentId="a" otherId="b" agentName="A" otherName="B" pairs={pairs} onClose={vi.fn()} onRemoved={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    expect(view.getByText('Conflicting original guidance (retained)')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: '' } });
    expect(view.getByRole('button', { name: 'Save direction' })).toBeDisabled();
    fireEvent.click(view.getByRole('checkbox', { name: /Replace effective guidance/ }));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Preview descriptions' })); });
    expect(view.getByText('Actual sanitized scoped description')).toBeInTheDocument();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledWith('a', 'b', expect.objectContaining({ instructions: { '*': '', absent_tool: 'Retain me' }, replaceAcrossSources: true }));
    expect(originals.map((source) => source.instructions['*'])).toEqual(['Original one', 'Original two']);
  });

  it('reports an unavailable catalog without fabricating choices or allowing writes', async () => {
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'unavailable', reason: 'tools_not_registered', tools: [] }));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    expect(textarea).toBeDisabled();
    expect(view.getByRole('alert')).toHaveTextContent('Tool catalog unavailable');
    expect(view.queryByRole('option', { name: 'real_registered_tool' })).toBeNull();
    expect(view.getByRole('option', { name: 'absent_tool (saved; unavailable)' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Save direction' })).toBeDisabled();
  });

  it('protects membership-owned guidance and reports read failures with an explicit retry', async () => {
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn().mockRejectedValueOnce(new Error('Sources unreadable')).mockImplementation(async (from, to) => snapshot(from, to, {
      readOnly: true, readOnlyReason: 'Managed by Annex Network membership.',
    }));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    expect(await view.findByRole('button', { name: 'Retry guidance' })).toBeInTheDocument();
    expect(view.getByRole('alert')).toHaveTextContent('Sources unreadable');
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Retry guidance' })); });
    expect(view.getByRole('textbox', { name: 'Instructions' })).toBeDisabled();
    expect(view.getByRole('alert')).toHaveTextContent('Managed by Annex Network membership');
  });

  it('retains both suspended source directions without inventing live bindings or editable guidance', async () => {
    useMcpBindingStore.setState({ bindings: [] });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: pairs.map((pair) => ({
        ...pair, bound: false, sources: [{ kind: 'dispatcher_link' as const, sourceId: 'dispatcher-connections', suspended: 'Dispatcher off' }],
      })), unreadable: [],
    }));
    window.clubhouse.mcpBinding.removeConnectionSource = vi.fn(async () => ({ ok: true, remaining: [], stillConnected: false }));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    expect(await view.findByTestId('connection-source-dispatcher_link')).toHaveTextContent('Not connected now: Dispatcher off');
    expect(window.clubhouse.mcpBinding.getConnectionGuidance).not.toHaveBeenCalled();
    expect(view.queryByRole('textbox', { name: 'Instructions' })).toBeNull();
    fireEvent.click(view.getByTestId('connection-source-remove-dispatcher_link'));
    await act(async () => { fireEvent.click(view.getByTestId('connection-source-confirm-dispatcher_link')); });
    expect(window.clubhouse.mcpBinding.removeConnectionSource).toHaveBeenCalledTimes(2);
    expect(window.clubhouse.mcpBinding.removeConnectionSource).toHaveBeenCalledWith('a', 'b', 'dispatcher_link');
    expect(window.clubhouse.mcpBinding.removeConnectionSource).toHaveBeenCalledWith('b', 'a', 'dispatcher_link');
  });
});
