import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { WireInstructionsDialog } from './WireInstructionsDialog';
import { ConnectionSourcesDialog } from '../../../features/agents/helpers/ConnectionSourcesDialog';
import { ConnectionsCard } from '../../../features/agents/helpers/ConnectionsCard';
import { WireConfigPopover } from './WireConfigPopover';
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
  window.clubhouse.mcpBinding.getDispatcherLinks = vi.fn(async () => []);
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
  it.each(['canvas', 'card'] as const)('opens the same searchable guidance editor from the %s entry point for an automatic connection', async (entry) => {
    const agent = { id: 'a', projectId: 'p', name: 'A', kind: 'durable' as const, status: 'sleeping' as const, color: 'teal' };
    useAgentStore.setState({ agents: { a: agent } });
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: pairs.map((pair) => ({ ...pair, sources: [{ kind: 'dispatcher_auto' as const, sourceId: 'dispatcher-wires' }] })), unreadable: [],
    }));
    const view = render(entry === 'canvas'
      ? <WireConfigPopover binding={binding} x={0} y={0} onClose={vi.fn()} />
      : <ConnectionsCard agent={agent} helperIds={new Set()} open onToggle={vi.fn()} onDisconnect={vi.fn()} />);
    fireEvent.click(await view.findByTestId(entry === 'canvas' ? 'wire-instructions-button' : 'connection-sources'));
    expect(await view.findByTestId('connection-guidance-editor')).toBeInTheDocument();
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    fireEvent.change(view.getByRole('searchbox', { name: 'Search tools' }), { target: { value: 'actual base' } });
    fireEvent.change(view.getByLabelText('Apply guidance to'), { target: { value: 'real_registered_tool' } });
    fireEvent.change(textarea, { target: { value: 'Automatic connection replacement' } });
    fireEvent.click(view.getByText('Configured overrides (2)'));
    expect(view.getByRole('list', { name: 'Configured tool overrides' })).toHaveTextContent('absent_tool');
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledExactlyOnceWith('a', 'b', expect.objectContaining({
      instructions: { '*': 'a default', absent_tool: 'Retain me', real_registered_tool: 'Automatic connection replacement' },
    }));
  });

  it('searches a large registered catalog by suffix and description without changing the selected draft', async () => {
    const tools = Array.from({ length: 600 }, (_, index) => ({
      suffix: `registered_${index}`, description: index === 417 ? 'Inspect release receipts' : `Catalog entry ${index}`, available: index !== 417,
    }));
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'available', tools }));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    const select = view.getByRole<HTMLSelectElement>('combobox', { name: 'Apply guidance to' });
    const search = view.getByRole('searchbox', { name: 'Search tools' });
    expect(select.options).toHaveLength(602);
    fireEvent.change(search, { target: { value: '  RELEASE RECEIPTS  ' } });
    expect(select.options).toHaveLength(2);
    expect(within(select).getByRole('option', { name: 'registered_417 (unavailable now)' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'registered_417' } });
    fireEvent.change(textarea, { target: { value: 'Specific gated-tool guidance' } });
    fireEvent.change(search, { target: { value: 'registered_599' } });
    expect(select).toHaveValue('registered_417');
    expect(textarea).toHaveValue('Specific gated-tool guidance');
    expect(within(select).getByRole('option', { name: 'registered_599' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Default for all tools' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'no matching tool' } });
    expect(view.getByText('No tools match. The default and selected tool remain available.')).toBeInTheDocument();
    expect(select).toHaveValue('registered_417');
    expect(textarea).toHaveValue('Specific gated-tool guidance');
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledWith('a', 'b', expect.objectContaining({
      instructions: { '*': 'a default', absent_tool: 'Retain me', registered_417: 'Specific gated-tool guidance' },
    }));
  });

  it('summarizes nonempty overrides independently of search and retains a selected tool when discovery changes', async () => {
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => snapshot(from, to, {
      instructions: { '*': 'Default', absent_tool: 'Saved absent', real_registered_tool: 'Specific', cleared_tool: '' },
    }));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    const summary = view.getByText('Configured overrides (2)');
    fireEvent.click(summary);
    const overrides = view.getByRole('list', { name: 'Configured tool overrides' });
    expect(within(overrides).getByRole('button', { name: 'absent_tool (saved; unavailable)' })).toBeInTheDocument();
    expect(within(overrides).queryByText('cleared_tool')).toBeNull();
    fireEvent.change(view.getByRole('searchbox', { name: 'Search tools' }), { target: { value: 'real_registered' } });
    fireEvent.click(within(overrides).getByRole('button', { name: 'absent_tool (saved; unavailable)' }));
    expect(view.getByLabelText('Apply guidance to')).toHaveValue('absent_tool');
    expect(textarea).toHaveValue('Saved absent');
    fireEvent.change(textarea, { target: { value: 'Retain absent draft' } });
    fireEvent.click(within(overrides).getByRole('button', { name: 'real_registered_tool' }));
    fireEvent.change(textarea, { target: { value: 'Retain registered draft' } });
    window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn().mockRejectedValue(new Error('Save refused'));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(view.getByRole('alert')).toHaveTextContent('Your draft is still here');
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'available', tools: [] }));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Reload sources and keep draft' })); });
    expect(view.getByLabelText('Apply guidance to')).toHaveValue('real_registered_tool');
    expect(textarea).toHaveValue('Retain registered draft');
    expect(view.getByRole('option', { name: 'real_registered_tool (saved; unavailable)' })).toBeInTheDocument();
    fireEvent.click(within(overrides).getByRole('button', { name: 'absent_tool (saved; unavailable)' }));
    expect(textarea).toHaveValue('Retain absent draft');
    window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn(async (from, to, request) => snapshot(from, to, { instructions: request.instructions }));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledExactlyOnceWith('a', 'b', expect.objectContaining({
      instructions: { '*': 'Default', absent_tool: 'Retain absent draft', real_registered_tool: 'Retain registered draft', cleared_tool: '' },
    }));
  });

  it('keeps unsaved default and tool drafts isolated across directions and explicit reverse copying', async () => {
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    await waitFor(() => expect(view.getByRole('button', { name: 'Copy guidance to reverse draft' })).toBeEnabled());
    fireEvent.change(textarea, { target: { value: 'Forward default draft' } });
    fireEvent.change(view.getByLabelText('Apply guidance to'), { target: { value: 'real_registered_tool' } });
    fireEvent.change(textarea, { target: { value: 'Forward tool draft' } });
    fireEvent.click(view.getByRole('button', { name: 'B to a' }));
    expect(textarea).toHaveValue('b default');
    fireEvent.change(textarea, { target: { value: 'Reverse draft' } });
    fireEvent.click(view.getByRole('button', { name: 'a to B' }));
    expect(textarea).toHaveValue('Forward default draft');
    fireEvent.change(view.getByLabelText('Apply guidance to'), { target: { value: 'real_registered_tool' } });
    expect(textarea).toHaveValue('Forward tool draft');
    fireEvent.click(view.getByRole('button', { name: 'Copy guidance to reverse draft' }));
    expect(textarea).toHaveValue('Forward default draft');
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Preview descriptions' })); });
    expect(view.getByText('Actual sanitized scoped description')).toBeInTheDocument();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledExactlyOnceWith('b', 'a', expect.objectContaining({
      instructions: { '*': 'Forward default draft', absent_tool: 'Retain me', real_registered_tool: 'Forward tool draft' },
    }));
  });

  it('shows the backend runtime notice and never infers live refresh from a successful save', async () => {
    const notice = 'Guidance saved. Restart the sender session to load its fixed tool descriptions. Sessions were not restarted.';
    window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn(async (from, to, request) => snapshot(from, to, { instructions: request.instructions, notice }));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    fireEvent.change(textarea, { target: { value: 'Updated' } });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(view.getByRole('status')).toHaveTextContent(notice);
    window.clubhouse.mcpBinding.saveConnectionGuidance = vi.fn(async (from, to, request) => snapshot(from, to, { instructions: request.instructions }));
    fireEvent.change(textarea, { target: { value: 'Updated again' } });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(view.getByRole('status')).toHaveTextContent(/refresh.*not confirmed/i);
    expect(view.getByRole('status')).toHaveTextContent(/reload.*restart/i);
  });

  it('uses the real catalog, retains absent overrides and saves only the chosen direction', async () => {
    const onClose = vi.fn();
    const view = render(<WireInstructionsDialog binding={binding} onClose={onClose} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    expect(textarea).toHaveValue('a default');
    const select = view.getByLabelText('Apply guidance to');
    expect(view.getByRole('option', { name: 'real_registered_tool' })).toBeInTheDocument();
    expect(view.getByRole('option', { name: 'absent_tool (saved; unavailable)' })).toBeInTheDocument();
    expect(view.queryByRole('option', { name: 'send_message' })).toBeNull();
    fireEvent.change(select, { target: { value: 'absent_tool' } });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Preview descriptions' })); });
    expect(view.getByText('No registered description is available for this tool. Its guidance is retained.')).toBeInTheDocument();
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

  it('allows default and saved-override editing without fabricating unavailable catalog choices', async () => {
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'unavailable', reason: 'tools_not_registered', tools: [] }));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    expect(textarea).toBeEnabled();
    expect(view.getByRole('alert')).toHaveTextContent('Tool catalog unavailable');
    expect(view.queryByRole('option', { name: 'real_registered_tool' })).toBeNull();
    expect(view.getByRole('option', { name: 'absent_tool (saved; unavailable)' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Preview descriptions' })).toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'Save without tool discovery' } });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledWith('a', 'b', expect.objectContaining({
      instructions: { '*': 'Save without tool discovery', absent_tool: 'Retain me' },
    }));
    fireEvent.change(view.getByLabelText('Apply guidance to'), { target: { value: 'absent_tool' } });
    expect(textarea).toHaveValue('Retain me');
    expect(textarea).toBeEnabled();
    expect(view.getByRole('button', { name: 'Copy guidance to reverse draft' })).toBeEnabled();
  });

  it('retains a healthy editable snapshot when the catalog request rejects and permits a retry', async () => {
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn().mockRejectedValue(new Error('Tool index disconnected'));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    expect(view.getByRole('alert')).toHaveTextContent('Tool index disconnected');
    expect(textarea).toHaveValue('a default');
    expect(textarea).toBeEnabled();
    fireEvent.change(textarea, { target: { value: 'Keep while retrying tools' } });
    window.clubhouse.mcpBinding.getConnectionToolCatalog = vi.fn(async () => ({ state: 'available', tools: [] }));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Reload sources and keep draft' })); });
    expect(textarea).toHaveValue('Keep while retrying tools');
    expect(view.getByRole('button', { name: 'Preview descriptions' })).toBeEnabled();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save direction' })); });
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).toHaveBeenCalledWith('a', 'b', expect.objectContaining({
      instructions: expect.objectContaining({ '*': 'Keep while retrying tools' }),
    }));
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
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => snapshot(from, to, {
      offline: true, readOnly: true, readOnlyReason: 'Saved guidance only; reconnect before editing.',
    }));
    const view = render(<WireInstructionsDialog binding={binding} onClose={vi.fn()} />);
    expect(await view.findByTestId('connection-source-dispatcher_link')).toHaveTextContent('Not connected now: Dispatcher off');
    expect(await view.findByRole('textbox', { name: 'Instructions' })).toHaveValue('a default');
    expect(view.getByRole('textbox', { name: 'Instructions' })).toBeDisabled();
    expect(window.clubhouse.mcpBinding.getConnectionGuidance).toHaveBeenCalledWith('a', 'b');
    expect(window.clubhouse.mcpBinding.getConnectionGuidance).toHaveBeenCalledWith('b', 'a');
    expect(window.clubhouse.mcpBinding.getConnectionToolCatalog).not.toHaveBeenCalled();
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).not.toHaveBeenCalled();
    expect(useMcpBindingStore.getState().bindings).toEqual([]);
    fireEvent.click(view.getByTestId('connection-source-remove-dispatcher_link'));
    await act(async () => { fireEvent.click(view.getByTestId('connection-source-confirm-dispatcher_link')); });
    expect(window.clubhouse.mcpBinding.removeConnectionSource).toHaveBeenCalledTimes(2);
    expect(window.clubhouse.mcpBinding.removeConnectionSource).toHaveBeenCalledWith('a', 'b', 'dispatcher_link');
    expect(window.clubhouse.mcpBinding.removeConnectionSource).toHaveBeenCalledWith('b', 'a', 'dispatcher_link');
  });

  it('retains a dirty direction draft when a saved connection temporarily suspends and reconnects', async () => {
    let suspended = false;
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => snapshot(from, to, {
      offline: suspended, readOnly: suspended,
      ...(suspended && { readOnlyReason: 'Saved guidance only; reconnect before editing.' }),
    }));
    const props = { agentId: 'a', otherId: 'b', agentName: 'A', otherName: 'B', onClose: vi.fn(), onRemoved: vi.fn() };
    const view = render(<ConnectionSourcesDialog {...props} pairs={pairs} />);
    const textarea = await view.findByRole('textbox', { name: 'Instructions' });
    fireEvent.change(textarea, { target: { value: 'Keep across temporary suspension' } });
    suspended = true;
    view.rerender(<ConnectionSourcesDialog {...props} pairs={pairs.map((pair) => ({
      ...pair, bound: false, sources: [{ kind: 'dispatcher_link' as const, sourceId: 'dispatcher-connections', suspended: 'Dispatcher off' }],
    }))} />);
    expect(view.getByRole('textbox', { name: 'Instructions' })).toBeDisabled();
    await waitFor(() => expect(view.getByRole('textbox', { name: 'Instructions' })).toHaveValue('a default'));
    expect(view.getByText('Unsaved draft (retained; not saved)')).toBeInTheDocument();
    expect(view.getByText('*: Keep across temporary suspension')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Save direction' })).toBeDisabled();
    suspended = false;
    view.rerender(<ConnectionSourcesDialog {...props} pairs={pairs} />);
    await waitFor(() => expect(view.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Keep across temporary suspension'));
    expect(view.getByRole('textbox', { name: 'Instructions' })).toBeEnabled();
  });

  it.each(['canvas', 'card'] as const)('inspects saved suspended guidance from the %s entrypoint and fails visibly when its source cannot be proved', async (entry) => {
    const agent = { id: 'a', projectId: 'p', name: 'A', kind: 'durable' as const, status: 'sleeping' as const, color: 'teal' };
    useAgentStore.setState({ agents: { a: agent } });
    useMcpBindingStore.setState({ bindings: [] });
    window.clubhouse.mcpBinding.getDispatcherLinks = vi.fn(async () => pairs.map((pair) => ({
      agentId: pair.agentId, targetId: pair.targetId, agentName: pair.agentId.toUpperCase(), targetName: pair.targetId.toUpperCase(),
      status: 'suspended' as const, reason: 'dispatcher_off' as const,
    })));
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({
      pairs: pairs.map((pair) => ({ ...pair, bound: false, sources: [{ kind: 'dispatcher_link' as const, sourceId: 'dispatcher-connections', suspended: 'Dispatcher off' }] })),
      unreadable: [],
    }));
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn().mockRejectedValue(new Error('Saved source could not be proved'));
    const view = render(entry === 'canvas'
      ? <WireInstructionsDialog binding={binding} onClose={vi.fn()} />
      : <ConnectionsCard agent={agent} helperIds={new Set()} open onToggle={vi.fn()} onDisconnect={vi.fn()} />);
    if (entry === 'card') fireEvent.click(await view.findByRole('button', { name: 'Edit' }));
    expect(await view.findByRole('button', { name: 'Retry guidance' })).toBeInTheDocument();
    expect(view.getByText('Saved source could not be proved')).toBeInTheDocument();
    expect(view.queryByRole('textbox', { name: 'Instructions' })).toBeNull();
    window.clubhouse.mcpBinding.getConnectionGuidance = vi.fn(async (from, to) => snapshot(from, to, {
      offline: true, readOnly: true, hasOverride: true, readOnlyReason: 'Saved guidance only; no session was started.',
    }));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Retry guidance' })); });
    const textarea = view.getByRole('textbox', { name: 'Instructions' });
    expect(textarea).toHaveValue('a default');
    expect(textarea).toBeDisabled();
    fireEvent.change(view.getByLabelText('Apply guidance to'), { target: { value: 'absent_tool' } });
    expect(textarea).toHaveValue('Retain me');
    expect(view.getByRole('button', { name: 'Save direction' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Preview descriptions' })).toBeDisabled();
    expect(window.clubhouse.mcpBinding.getConnectionToolCatalog).not.toHaveBeenCalled();
    expect(window.clubhouse.mcpBinding.saveConnectionGuidance).not.toHaveBeenCalled();
    expect(useMcpBindingStore.getState().bindings).toEqual([]);
  });
});
