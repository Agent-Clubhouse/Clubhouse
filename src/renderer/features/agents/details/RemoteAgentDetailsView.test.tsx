import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import { REMOTE_DETAILS_CARD_IDS, type RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../../shared/chat';
import { createChatViewState, useChatStore } from '../../../stores/chatStore';
import { AgentDetails } from './AgentDetails';
import { useAgentDetailsStore } from './detailsStore';

const agent: Agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', name: 'Remote', kind: 'durable', status: 'running', color: 'blue' };
const read = vi.fn();
const chatPage = vi.fn();
const page = (version = '1.2.3', extra = {}) => ({ events: [
  { v: 2, agentId: 'a1', sessionId: 's1', seq: 1, ts: 1, type: 'session_started', data: { provider: 'claude-code', driver: 'claude_agent_sdk', nativeSessionId: 'n1', cliVersion: version, resumed: false, cwd: '/host', capabilities: MINIMAL_CHAT_CAPABILITIES } },
  { v: 2, agentId: 'a1', sessionId: 's1', seq: 2, ts: 2, type: 'session_info', data: { nativeSessionId: 'n1', mcpServers: [{ name: 'PROVIDER_MCP', status: 'connected' }], providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'n1', names: ['host-skill'] } } },
  { v: 2, agentId: 'a1', sessionId: 's1', seq: 3, ts: 3, type: 'model_changed', data: { modelId: 'model', effort: 'high', effortIsDefault: true } },
], readOnly: false, ...extra });
const fixture = (): RemoteAgentDetails => ({ version: 1, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'claude-code', running: true, status: 'running', spawnedAt: null, sessionId: 's1', nativeSessionId: 'n1',
  settings: { version: 1, agentId: 'a1', readOnly: true, provider: 'Host CLI', model: 'host-model', runtime: 'chat', access: 'Ask first', executionPolicy: 'defaults', autoSleep: null, context: null, setup: { state: 'ok', managed: false, template: null, instructions: 'None', skills: null, mcps: [] } },
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id === 'orchestrate' ? 'Orchestration' : id, state: 'ok', summary: `Host ${id}`, rows: [{ label: `${id} field`, value: `${id} evidence` }], notes: [], omitted: 0, observedAt: 1 })) });
function satellite(extra: Record<string, unknown> = {}) {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', alias: 'Studio', state: 'connected', snapshot: {}, ...extra }] as never });
}
beforeEach(() => {
  satellite();
  useChatStore.getState().reset(agent.id);
  chatPage.mockResolvedValue(page());
  useAgentDetailsStore.setState({ settingsOpen: true, focus: null });
  read.mockResolvedValue({ status: 'ok', value: fixture() });
  Object.assign(window.clubhouse.annexClient, { agentDetails: read, chatPage });
  for (const [object, method] of [[window.clubhouse.actions, 'list'], [window.clubhouse.git, 'branchChanges'], [window.clubhouse.agent, 'getDurableConfig'], [window.clubhouse.managed, 'getSetup'], [window.clubhouse.mcpBinding, 'getAgentConnection'], [window.clubhouse.canvas, 'getAgentCanvases']] as const) Object.assign(object, { [method]: vi.fn() });
});
describe('remote full Details host evidence', () => {
  it.each(['running', 'sleeping', 'waking', 'error'] as const)('renders applicable host cards read-only for a %s agent with no local reads', async (status) => {
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), status, running: status === 'running' } });
    render(<AgentDetails agent={{ ...agent, status }} />);
    await waitFor(() => expect(read).toHaveBeenCalledWith('sat', 'a1'));
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI'));
    for (const id of ['changes', 'dispatcher', 'orchestrate', 'connections', 'actions', 'skills-mcp', 'session', 'canvases']) {
      const toggle = screen.getByTestId(`details-card-${id}-toggle`);
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
      expect(within(screen.getByTestId(`details-card-${id}`)).getByText(`${id} evidence`)).toBeInTheDocument();
    }
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(window.clubhouse.actions.list).not.toHaveBeenCalled();
    expect(window.clubhouse.git.branchChanges).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
    expect(window.clubhouse.managed.getSetup).not.toHaveBeenCalled();
    expect(window.clubhouse.mcpBinding.getAgentConnection).not.toHaveBeenCalled();
    expect(window.clubhouse.canvas.getAgentCanvases).not.toHaveBeenCalled();
  });
  it('preserves Effort/default, CLI version and inherited-provider skills bound to the selected session', async () => {
    const chat = { ...createChatViewState(agent.id), provider: 'claude-code', driver: 'claude_agent_sdk' as const, sessionId: 's1', nativeSessionId: 'n1', effort: 'high', effortReported: true, effortIsDefault: true, cliVersion: '1.2.3', providerSkills: { provider: 'claude-code' as const, driver: 'claude_agent_sdk' as const, source: 'system/init' as const, sessionId: 's1', nativeSessionId: 'n1', reportedAt: 1000, names: ['host-skill'] } };
    render(<AgentDetails agent={agent} chat={chat} />);
    await screen.findByText('Host CLI 1.2.3');
    expect(screen.getByTestId('details-setting-effort')).toHaveTextContent('High (default)');
    fireEvent.click(screen.getByTestId('details-card-skills-mcp-toggle'));
    expect(screen.getByText('host-skill')).toBeInTheDocument();
  });
  it('invalidates results on snapshot loss/offline and ignores a late previous-host result', async () => {
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    view.rerender(<AgentDetails agent={{ ...agent, id: 'remote||sat||other' }} />);
    await act(async () => { finish({ status: 'ok', value: fixture() }); });
    expect(screen.queryByText('Host CLI')).not.toBeInTheDocument();
    act(() => satellite({ state: 'disconnected' }));
    expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('Host offline');
    act(() => satellite({ snapshotUnavailable: true }));
    expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('snapshot is unavailable');
  });
  it('keeps unsupported/error/offline distinct from empty, and exposes each bounded omission', async () => {
    const value = fixture();
    Object.assign(value.cards.find((c) => c.id === 'actions')!, { state: 'error', summary: '', rows: [], notes: [] });
    Object.assign(value.cards.find((c) => c.id === 'connections')!, { omitted: 7 });
    read.mockResolvedValue({ status: 'ok', value });
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI'));
    fireEvent.click(screen.getByTestId('details-card-actions-toggle'));
    expect(screen.getByTestId('details-card-actions')).toHaveTextContent('Couldn’t read this section');
    expect(screen.getByTestId('details-card-actions')).not.toHaveTextContent('No actions');
    fireEvent.click(screen.getByTestId('details-card-connections-toggle'));
    expect(screen.getByTestId('details-card-connections')).toHaveTextContent('7 more rows omitted');
  });
  it('makes supplied Settings retry refetch the parent host Details request', async () => {
    read.mockResolvedValueOnce({ status: 'error' });
    render(<AgentDetails agent={agent} />);
    await screen.findByRole('button', { name: 'Try again' });
    expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI'));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(['forbidden', 'error', 'unavailable'] as const)('withholds retained provider evidence after a %s host read', async (status) => {
    read.mockResolvedValue({ status });
    const chat = { ...createChatViewState(agent.id), provider: 'claude-code', sessionId: 's1', nativeSessionId: 'n1', cliVersion: 'STALE_VERSION', effort: 'STALE_EFFORT', effortReported: true, mcpServers: [{ name: 'STALE_MCP', status: 'connected' as const }] };
    render(<AgentDetails agent={agent} chat={chat} />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('details-card-skills-mcp-toggle'));
    expect(screen.queryByText('STALE_MCP')).not.toBeInTheDocument();
    expect(screen.queryByText(/STALE_VERSION/)).not.toBeInTheDocument();
    expect(screen.queryByText(/STALE_EFFORT/)).not.toBeInTheDocument();
  });
  it('keeps the old host’s supported Settings endpoint while marking new cards unavailable', async () => {
    read.mockResolvedValue({ status: 'unavailable' });
    const settings = vi.fn(async () => ({ status: 'ok', value: fixture().settings }));
    Object.assign(window.clubhouse.annexClient, { agentSettings: settings });
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI'));
    expect(settings).toHaveBeenCalledWith('sat', 'a1');
    expect(screen.getByTestId('details-card-connections-summary')).toHaveTextContent('does not share these details');
  });
  it('withholds same-session retained evidence until reconnect hydration succeeds, even with the same snapshot object', async () => {
    const snapshot = {};
    satellite({ snapshot });
    chatPage.mockResolvedValue(page('Fresh A'));
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host CLI Fresh A');
    let finish!: (value: unknown) => void;
    chatPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => satellite({ state: 'disconnected', snapshot }));
    act(() => satellite({ state: 'connected', snapshot }));
    await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('Refreshing provider evidence'));
    expect(screen.queryByText('Host CLI Fresh A')).not.toBeInTheDocument();
    await act(async () => { finish(page('Fresh B')); });
    await screen.findByText('Host CLI Fresh B');
  });
  it('keeps retained evidence withheld after failed same-session hydration and identifies cut pages', async () => {
    chatPage.mockResolvedValueOnce(page('Fresh A'));
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host CLI Fresh A');
    chatPage.mockRejectedValueOnce(new Error('Read failed'));
    act(() => satellite());
    await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('Retained session data is withheld'));
    expect(screen.queryByText('Host CLI Fresh A')).not.toBeInTheDocument();
    chatPage.mockResolvedValueOnce(page('Fresh cut', { truncated: true }));
    act(() => satellite());
    await screen.findByText('Host CLI Fresh cut');
    expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('Only part of the host transcript is loaded');
  });
  it.each(['readOnly', 'error', 'session-ended'] as const)('withholds current claims after Details succeeds but delayed hydration is %s', async (mode) => {
    const value = fixture();
    value.spawnedAt = 1;
    value.cards.find((c) => c.id === 'skills-mcp')!.rows.push({ label: 'Clubhouse MCP', value: 'Connected · CURRENT_HANDSHAKE' });
    value.cards.find((c) => c.id === 'session')!.rows.push({ label: 'Status', value: 'running' });
    read.mockResolvedValue({ status: 'ok', value });
    const stopped = page('HISTORICAL_VERSION', mode === 'readOnly' ? { readOnly: true, state: 'sleeping' } : mode === 'error' ? { state: 'error' } : {});
    if (mode === 'session-ended') stopped.events.push({ v: 2, agentId: 'a1', sessionId: 's1', seq: 4, ts: 4, type: 'session_ended', data: { reason: 'stopped' } } as never);
    let finish!: (value: unknown) => void;
    chatPage.mockResolvedValue(stopped).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(1));
    // The independent Details read has already said running; hydration now contradicts it on the same IDs.
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { finish(stopped); });
    for (const id of ['skills-mcp', 'session']) {
      const toggle = screen.getByTestId(`details-card-${id}-toggle`);
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    }
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('details-card-session')).toHaveTextContent('Current run state is not confirmed'));
    expect(screen.queryByText(/HISTORICAL_VERSION/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-setting-effort')).not.toBeInTheDocument();
    expect(screen.queryByText('host-skill')).not.toBeInTheDocument();
    expect(screen.queryByText('PROVIDER_MCP')).not.toBeInTheDocument();
    expect(screen.queryByText(/CURRENT_HANDSHAKE/)).not.toBeInTheDocument();
    expect(screen.getByTestId('details-setting-runs-in')).toHaveTextContent('current run not confirmed');
    expect(screen.getByTestId('details-card-session')).not.toHaveTextContent('Running');
    expect(screen.getByTestId('details-card-session')).not.toHaveTextContent('Last session');
    expect(useChatStore.getState().remoteReadReceipts[agent.id]).toMatchObject({ live: mode !== 'readOnly', state: mode === 'session-ended' ? null : mode === 'readOnly' ? 'sleeping' : 'error' });
    // The unchanged contradictory read must not form a poll loop.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('invalidates a successful live receipt after a later same-session stop, including a failed lifecycle reread', async () => {
    const value = fixture();
    value.cards.find((c) => c.id === 'skills-mcp')!.rows.push({ label: 'Clubhouse MCP', value: 'Connected · CURRENT_HANDSHAKE' });
    read.mockResolvedValueOnce({ status: 'ok', value }).mockResolvedValue({ status: 'error' });
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host CLI 1.2.3');
    fireEvent.click(screen.getByTestId('details-card-skills-mcp-toggle'));
    expect(screen.getByText('host-skill')).toBeInTheDocument();
    expect(screen.getByText('PROVIDER_MCP')).toBeInTheDocument();
    act(() => useChatStore.getState().applyEvent({ v: 2, agentId: agent.id, sessionId: 's1', seq: 4, ts: 4, type: 'session_ended', data: { reason: 'error' } }));
    expect(screen.queryByText('Host CLI 1.2.3')).not.toBeInTheDocument();
    expect(screen.queryByText('host-skill')).not.toBeInTheDocument();
    expect(screen.queryByText('PROVIDER_MCP')).not.toBeInTheDocument();
    expect(screen.queryByText(/CURRENT_HANDSHAKE/)).not.toBeInTheDocument();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('Couldn’t read details'));
    expect(screen.queryByText(/CURRENT_HANDSHAKE/)).not.toBeInTheDocument();
    expect(screen.queryByText('Host CLI 1.2.3')).not.toBeInTheDocument();
  });
});
