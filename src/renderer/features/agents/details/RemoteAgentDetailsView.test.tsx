import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import { isRemoteAgentDetails, REMOTE_DETAILS_CARD_IDS, type RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../../shared/chat';
import { createChatViewState, useChatStore } from '../../../stores/chatStore';
import { AgentDetails } from './AgentDetails';
import { useHelperStartRequestStore } from '../../../stores/helperStartRequestStore';
import { useAgentDetailsStore } from './detailsStore';

const agent: Agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', name: 'Remote', kind: 'durable', status: 'running', color: 'blue' };
const read = vi.fn();
const chatPage = vi.fn();
const changes = vi.fn();
const page = (version = '1.2.3', extra = {}) => ({ events: [
  { v: 2, agentId: 'a1', sessionId: 's1', seq: 1, ts: 1, type: 'session_started', data: { provider: 'claude-code', driver: 'claude_agent_sdk', nativeSessionId: 'n1', cliVersion: version, resumed: false, cwd: '/host', capabilities: MINIMAL_CHAT_CAPABILITIES } },
  { v: 2, agentId: 'a1', sessionId: 's1', seq: 2, ts: 2, type: 'session_info', data: { nativeSessionId: 'n1', mcpServers: [{ name: 'PROVIDER_MCP', status: 'connected' }], providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'n1', names: ['host-skill'] } } },
  { v: 2, agentId: 'a1', sessionId: 's1', seq: 3, ts: 3, type: 'model_changed', data: { modelId: 'model', effort: 'high', effortIsDefault: true } },
], readOnly: false, ...extra });
const fixture = (): RemoteAgentDetails => ({ version: 1, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'claude-code', running: true, status: 'running', spawnedAt: null, sessionId: 's1', nativeSessionId: 'n1',
  settings: { version: 1, agentId: 'a1', readOnly: true, provider: 'Host CLI', providerId: 'claude-code', model: 'host-model', runtime: 'chat', access: 'Ask first', executionPolicy: 'defaults', autoSleep: null, context: null, setup: { state: 'ok', managed: false, template: null, instructions: 'None', skills: null, mcps: [] } },
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id === 'orchestrate' ? 'Orchestration' : id, state: 'ok', summary: `Host ${id}`, rows: [{ label: `${id} field`, value: `${id} evidence` }], notes: [], omitted: 0, observedAt: 1 })) });
function satellite(extra: Record<string, unknown> = {}) {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', alias: 'Studio', state: 'connected', snapshot: {}, ...extra }] as never });
}
beforeEach(() => {
  useHelperStartRequestStore.setState({ requests: {} });
  satellite();
  useChatStore.getState().reset(agent.id);
  chatPage.mockResolvedValue(page());
  useAgentDetailsStore.setState({ settingsOpen: true, focus: null });
  read.mockResolvedValue({ status: 'ok', value: fixture() });
  changes.mockImplementation(async (_host, id, query) => ({ status: 'ok', value: { version: 1, readOnly: true, agentId: id, observedAt: 1, scope: query.scope, state: 'ok', branch: 'host-branch', base: 'host-main', sessionId: null, turnId: null, live: true, shared: false, files: [], totalFiles: 0, offset: query.offset ?? 0, nextOffset: null, uncompared: 0, skippedLarge: [], skippedRepos: [], skippedOmitted: 0 } }));
  Object.assign(window.clubhouse.annexClient, { agentDetails: read, chatPage, agentChanges: changes, agentSettings: vi.fn(async () => ({ status: 'unavailable' })) });
  for (const [object, method] of [[window.clubhouse.actions, 'list'], [window.clubhouse.git, 'branchChanges'], [window.clubhouse.agent, 'getDurableConfig'], [window.clubhouse.managed, 'getSetup'], [window.clubhouse.mcpBinding, 'getAgentConnection'], [window.clubhouse.canvas, 'getAgentCanvases']] as const) Object.assign(object, { [method]: vi.fn() });
});
describe('remote full Details host evidence', () => {
  const evidence = (runId = 'runtime-a') => ({ version: 1 as const, runId, agentId: 'a1', sessionId: 's1', nativeSessionId: 'n1', providerId: 'claude-code', driver: 'claude_agent_sdk' as const,
    startedAt: 1000, startSeq: 1, readAt: 9999, lastSeq: 3000, completeFromStart: true, values: {
      cliVersion: 'INITIAL_VERSION', model: 'initial-model', effort: { value: 'high', isDefault: true }, level: 'ask' as const,
      capabilities: { subagents: 'full' as const, usage: 'cost' as const, limits: true }, mcpServers: [{ name: 'INITIAL_MCP', status: 'connected' as const }],
      skills: { provider: 'claude-code' as const, driver: 'claude_agent_sdk' as const, source: 'system/init' as const, nativeSessionId: 'n1', names: ['initial-skill'], reportedAt: 2000 },
      subagents: [{ subagentId: 'initial-sub', name: 'Initial reviewer', status: 'completed' as const, toolCount: 4, usage: { total: 42 } }],
      sessionUsage: { costUsd: 0, tokens: { total: 123 } }, context: { used: 100, size: 200_000 },
    }, observedAt: { cliVersion: 2000, model: 2000, effort: 2000, level: 1000, capabilities: 1000, mcpServers: 2000, skills: 2000, subagents: 2500, sessionUsage: 2600, context: 2600 }, omitted: {} });
  it('carries the real transcript cursor/receipt into explicit older Details reads without replacing current provider facts', async () => {
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidence: evidence() } });
    const historyBinding = { version: 1, projectId: 'p1', agentId: 'a1', sessionId: 's1', providerId: 'claude-code', driver: 'claude_agent_sdk', nativeSessionId: 'n1', displayRunId: 'runtime-a', startSeq: 1, subagents: 'full' };
    chatPage.mockImplementation(async (_host, _id, query) => page('tail', { agentId: 'a1', sessionId: 's1', currentSessionId: 's1', state: 'idle', displayRunId: 'runtime-a', historyBinding,
      truncated: !query.beforeSeq, nextBeforeSeq: query.beforeSeq ? null : 3000,
      events: query.beforeSeq ? [{ v: 2, agentId: 'a1', sessionId: 's1', seq: 100, ts: 100, type: 'subagent', data: { subagentId: 'archived-child', name: 'Archived actual-pipeline child', status: 'completed' } }]
        : [{ v: 2, agentId: 'a1', sessionId: 's1', seq: 3000, ts: 3000, type: 'notice', data: { level: 'info', message: 'tail' } }],
    }));
    useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'session' });
    render(<AgentDetails agent={agent} />);
    const older = await screen.findByRole('button', { name: 'Read older session history' });
    expect(chatPage).toHaveBeenCalledTimes(1);
    fireEvent.click(older);
    await screen.findByText(/Child report: Archived actual-pipeline child/);
    expect(chatPage).toHaveBeenLastCalledWith('sat', 'a1', { beforeSeq: 3000, limit: 200 });
    expect(screen.getByTestId('details-card-settings')).toHaveTextContent('INITIAL_VERSION');
    expect(useChatStore.getState().agents[agent.id].subagents['archived-child']).toBeUndefined();
  });
  it('resolves a pending Subagents focus after hydration, expands the requested child, and handles it once', async () => {
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidence: evidence() } });
    let finish!: (value: ReturnType<typeof page>) => void;
    chatPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'subagents', subagentId: 'initial-sub' });
    const jump = vi.fn();
    const view = render(<AgentDetails agent={agent} onShowInStream={jump} />);
    await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('details-card-session-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('details-card-subagents')).not.toBeInTheDocument();
    await act(async () => { finish(page('1.2.3', { displayRunId: 'runtime-a' })); });
    await waitFor(() => expect(screen.getByTestId('details-card-subagents-toggle')).toHaveAttribute('aria-expanded', 'true'));
    const child = screen.getByTestId('agent-map-node');
    expect(child).toHaveAttribute('data-subagent-id', 'initial-sub');
    expect(within(child).getByRole('button', { name: /Initial reviewer/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(child).getByRole('button', { name: 'Show in conversation' }));
    expect(jump).toHaveBeenCalledExactlyOnceWith('initial-sub');
    fireEvent.click(screen.getByTestId('details-card-subagents-toggle'));
    view.rerender(<AgentDetails agent={{ ...agent, name: 'Renamed remote' }} onShowInStream={jump} />);
    expect(screen.getByTestId('details-card-subagents-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
    expect(window.clubhouse.actions.list).not.toHaveBeenCalled();
  });

  it('tries the fallback once while refresh delays first fulfillment, ignoring superseded hydration', async () => {
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidence: evidence() } });
    const finishes: Array<(value: ReturnType<typeof page>) => void> = [];
    chatPage.mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
    useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'subagents', subagentId: 'initial-sub' });
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('details-card-session-toggle')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    act(() => satellite());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('details-card-session-toggle')).toHaveAttribute('aria-expanded', 'false');
    // Transcript refreshes serialize; settling the superseded read admits the next one.
    await act(async () => { finishes[0](page('1.2.3', { displayRunId: 'runtime-a' })); });
    await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('details-card-subagents')).not.toBeInTheDocument();
    await act(async () => { finishes[1](page('1.2.3', { displayRunId: 'runtime-a' })); });
    await waitFor(() => expect(screen.getByTestId('details-card-subagents-toggle')).toHaveAttribute('aria-expanded', 'true'));
    expect(within(screen.getByTestId('agent-map-node')).getByRole('button', { name: /Initial reviewer/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('details-card-session-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([false, true])('keeps fulfilled focus collapsed across refresh (fallback manually closed: %s), and accepts a new nonce', async (closeFallback) => {
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidence: evidence() } });
    chatPage.mockResolvedValue(page('1.2.3', { displayRunId: 'runtime-a' }));
    useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'subagents', subagentId: 'initial-sub' });
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('details-card-subagents-toggle')).toHaveAttribute('aria-expanded', 'true'));
    // A user closes the requested child/card, optionally also the initial fallback.
    fireEvent.click(within(screen.getByTestId('agent-map-node')).getByRole('button', { name: /Initial reviewer/ }));
    fireEvent.click(screen.getByTestId('details-card-subagents-toggle'));
    if (closeFallback) fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    const fallbackExpanded = closeFallback ? 'false' : 'true';
    expect(screen.getByTestId('details-card-session-toggle')).toHaveAttribute('aria-expanded', fallbackExpanded);
    const nonce = useAgentDetailsStore.getState().focus!.nonce;
    let finish!: (value: ReturnType<typeof page>) => void;
    chatPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    // Normal host snapshot refresh invalidates Details, then waits for matching hydration.
    act(() => satellite());
    expect(screen.queryByTestId('details-card-subagents')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-session-toggle')).toHaveAttribute('aria-expanded', fallbackExpanded);
    await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('details-card-session-toggle')).toHaveAttribute('aria-expanded', fallbackExpanded);
    await act(async () => { finish(page('1.2.3', { displayRunId: 'runtime-a' })); });
    await waitFor(() => expect(screen.getByTestId('details-card-subagents-toggle')).toHaveAttribute('aria-expanded', 'false'));
    expect(useAgentDetailsStore.getState().focus!.nonce).toBe(nonce);
    fireEvent.click(screen.getByTestId('details-card-subagents-toggle'));
    expect(within(screen.getByTestId('agent-map-node')).getByRole('button', { name: /Initial reviewer/ })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByTestId('details-card-subagents-toggle'));
    act(() => useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'subagents', subagentId: 'initial-sub' }));
    expect(screen.getByTestId('details-card-subagents-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByTestId('agent-map-node')).getByRole('button', { name: /Initial reviewer/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not replay a pending focus or late hydration into a different host with the same raw agent id', async () => {
    read.mockResolvedValueOnce({ status: 'ok', value: { ...fixture(), providerEvidence: evidence() } });
    let finish!: (value: ReturnType<typeof page>) => void;
    chatPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    useAgentDetailsStore.getState().reveal({ agentId: agent.id, card: 'subagents', subagentId: 'initial-sub' });
    const view = render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(1));
    const other = { ...agent, id: 'remote||other-host||a1', projectId: 'remote||other-host||p1' };
    act(() => useAnnexClientStore.setState((s) => ({ satellites: [...s.satellites, { id: 'other-host', alias: 'Other host', state: 'connected', snapshot: {} } as never] })));
    view.rerender(<AgentDetails agent={other} />);
    await waitFor(() => expect(read).toHaveBeenLastCalledWith('other-host', 'a1'));
    await screen.findByText('Host CLI 1.2.3');
    await act(async () => { finish(page('1.2.3', { displayRunId: 'runtime-a' })); });
    expect(screen.getByTestId('details-card-session-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('details-card-subagents')).not.toBeInTheDocument();
    expect(screen.queryByText('Initial reviewer')).not.toBeInTheDocument();
    expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('Read from Other host');
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
    expect(window.clubhouse.actions.list).not.toHaveBeenCalled();
  });

  it.each([
    ['known total zero', { tokens: { total: 0 } }, 'tokens', '0 tokens'],
    ['absent', undefined, 'tokens', 'Not reported in the loaded session snapshot'],
    ['empty tokens', { tokens: {} }, 'tokens', 'Not reported in the loaded session snapshot'],
    ['partial input zero', { tokens: { input: 0 } }, 'tokens', '0 tokens'],
    ['partial output', { tokens: { output: 42 } }, 'tokens', '42 tokens'],
    ['input and output', { tokens: { input: 12, output: 30 } }, 'tokens', '42 tokens'],
    ['total takes precedence', { tokens: { total: 0, input: 42 } }, 'tokens', '0 tokens'],
    ['zero cost', { costUsd: 0 }, 'cost', '<$0.01'],
    ['zero cost and tokens', { costUsd: 0, tokens: { total: 0 } }, 'cost', '<$0.01 · 0 tokens'],
    ['usage none', { costUsd: 1, tokens: { total: 42 } }, 'none', 'Not reported in the loaded session snapshot'],
  ] as const)('preserves usage knownness: %s', async (_name, usage, capability, expected) => {
    const report = evidence();
    Object.assign(report.values, { sessionUsage: usage });
    Object.assign(report.values.capabilities, { usage: capability });
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidence: report } });
    chatPage.mockResolvedValue(page('1.2.3', { displayRunId: 'runtime-a' }));
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host CLI INITIAL_VERSION');
    const toggle = screen.getByTestId('details-card-session-toggle');
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    const card = screen.getByTestId('details-card-session');
    expect(within(card).getAllByText(expected, { exact: true }).length).toBeGreaterThan(0);
    if (capability === 'none' || !usage || 'tokens' in usage && Object.keys(usage.tokens).length === 0) {
      expect(card).not.toHaveTextContent('0 tokens');
    }
  });

  it('keeps known zero turn sums and their resumed-history qualification', async () => {
    const report = evidence();
    Object.assign(report.values, { sessionUsage: undefined, turnTotal: { input: 0, output: 0 } });
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidence: report } });
    chatPage.mockResolvedValue(page('1.2.3', { displayRunId: 'runtime-a' }));
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host CLI INITIAL_VERSION');
    const toggle = screen.getByTestId('details-card-session-toggle');
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    expect(screen.getByTestId('details-card-session')).toHaveTextContent('0 tokens');
    expect(screen.getByTestId('details-card-session')).toHaveTextContent('Earlier resumed conversation usage is separate');
  });

  it.each(['stop', 'offline', 'snapshot-loss', 'forbidden', 'unmount'] as const)('ticks elapsed body and collapsed summary without host events, then cleans up on %s', async (transition) => {
    vi.useFakeTimers();
    vi.setSystemTime(120_000);
    const value = fixture(); value.spawnedAt = 60_000;
    read.mockResolvedValue({ status: 'ok', value });
    const view = render(<AgentDetails agent={agent} />);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      const summary = screen.getByTestId('details-card-session-summary');
      expect(summary).toHaveTextContent('1m');
      const toggle = screen.getByTestId('details-card-session-toggle');
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
      expect(within(screen.getByTestId('details-card-session')).getAllByText('1m', { exact: true })).toHaveLength(2);
      fireEvent.click(toggle);
      const hostReads = read.mock.calls.length, pages = chatPage.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(summary).toHaveTextContent('1m 30s');
      fireEvent.click(toggle);
      expect(within(screen.getByTestId('details-card-session')).getAllByText('1m 30s', { exact: true })).toHaveLength(2);
      expect(read).toHaveBeenCalledTimes(hostReads);
      expect(chatPage).toHaveBeenCalledTimes(pages);
      if (transition === 'unmount') view.unmount();
      else if (transition === 'stop') {
        read.mockResolvedValue({ status: 'error' });
        act(() => useChatStore.getState().applyEvent({ v: 2, agentId: agent.id, sessionId: 's1', seq: 4, ts: 4, type: 'session_ended', data: { reason: 'stopped' } }));
      }
      else if (transition === 'offline') act(() => satellite({ state: 'disconnected' }));
      else {
        read.mockResolvedValue({ status: 'forbidden' });
        act(() => satellite(transition === 'snapshot-loss' ? { snapshotUnavailable: true } : {}));
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(vi.getTimerCount()).toBe(0);
      if (transition !== 'unmount') {
        expect(screen.queryByTestId('details-card-session-summary')).not.toBeInTheDocument();
        expect(within(screen.getByTestId('details-card-session')).queryByText('Running')).not.toBeInTheDocument();
      }
      const finalReads = read.mock.calls.length, finalPages = chatPage.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(read).toHaveBeenCalledTimes(finalReads);
      expect(chatPage).toHaveBeenCalledTimes(finalPages);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('renders shared read-only action group fields and outcome/time without local action APIs or management buttons', async () => {
    const value = fixture(); const card = value.cards.find((c) => c.id === 'actions')!;
    card.summary = '1 related'; card.rows = ['owned', 'targeting', 'triggered-by'].map((group) => ({ label: 'Host reminder', value: 'Legacy Off · Description · done', action: { group, enabled: false, description: 'When Selected sleeps → Message Selected', lastRun: { outcome: 'done', startedAt: 1000 } } })) as typeof card.rows;
    read.mockResolvedValue({ status: 'ok', value });
    for (const method of ['history', 'runNow', 'setEnabled', 'update', 'delete'] as const) Object.assign(window.clubhouse.actions, { [method]: vi.fn() });
    render(<AgentDetails agent={agent} />); await waitFor(() => expect(read).toHaveBeenCalled());
    const toggle = screen.getByTestId('details-card-actions-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    const actions = screen.getByTestId('details-card-actions'); await waitFor(() => expect(within(actions).getAllByTestId('remote-action-row')).toHaveLength(3));
    for (const label of ['Owned by Remote', 'Targets Remote', 'Set off by Remote']) expect(within(actions).getByRole('region', { name: label })).toBeInTheDocument();
    expect(actions).toHaveTextContent('Their usage counts toward Remote.');
    for (const row of within(actions).getAllByTestId('remote-action-row')) {
      expect(row).toHaveTextContent('Host reminder'); expect(row).toHaveTextContent('Off'); expect(row).toHaveTextContent('When Selected sleeps → Message Selected'); expect(row).toHaveTextContent('Done'); expect(row).not.toHaveTextContent('Legacy');
      expect(within(row).queryByRole('button')).not.toBeInTheDocument(); fireEvent.click(row);
    }
    for (const method of ['list', 'history', 'runNow', 'setEnabled', 'update', 'delete'] as const) expect(window.clubhouse.actions[method]).not.toHaveBeenCalled();
    expect(screen.queryByTestId('action-card')).not.toBeInTheDocument();
  });
  it('retains old-host plain action fields and explicitly marks unavailable group fields', async () => {
    const value = fixture(); const c = value.cards.find((c) => c.id === 'actions')!; c.rows = [{ label: 'Legacy reminder', value: 'Off · Targets this agent · Message Selected · failed' }];
    read.mockResolvedValue({ status: 'ok', value }); render(<AgentDetails agent={agent} />); await waitFor(() => expect(read).toHaveBeenCalled());
    const toggle = screen.getByTestId('details-card-actions-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    const card = screen.getByTestId('details-card-actions'); await waitFor(() => expect(card).toHaveTextContent('Legacy reminder'));
    expect(card).toHaveTextContent('Off · Targets this agent · Message Selected · failed'); expect(card).toHaveTextContent('without relationship group fields');
    expect(within(card).queryByTestId('remote-action-row')).not.toBeInTheDocument(); expect(window.clubhouse.actions.list).not.toHaveBeenCalled();
  });
  it.each(['recorded', 'unknown'] as const)('keeps sleeping historical CLI separate from next-start and cached sleep fields: %s', async (mode) => {
    const value = fixture(); Object.assign(value, { running: false, status: 'sleeping', sessionId: null, nativeSessionId: null, providerLabel: 'Host Next Codex' });
    value.settings = { ...value.settings!, provider: 'Host Next Codex', providerId: 'codex-cli' };
    const c = value.cards.find((c) => c.id === 'session')!;
    c.title = 'Last session'; c.rows = [{ label: 'Last CLI', value: mode === 'recorded' ? 'Historical Claude' : 'Not recorded unambiguously for this session' }, { label: 'Ended', value: 'HOST_END' }, { label: 'Why', value: 'HOST_EXIT_REASON' }];
    read.mockResolvedValue({ status: 'ok', value });
    render(<AgentDetails agent={{ ...agent, status: 'sleeping', lastSleep: { at: '2026-01-01T00:00:00Z', reason: 'user' } }} />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    const toggle = screen.getByTestId('details-card-session-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('details-card-session')).toHaveTextContent('HOST_EXIT_REASON'));
    const session = screen.getByTestId('details-card-session');
    expect.soft(session).toHaveTextContent(mode === 'recorded' ? 'Historical Claude' : 'Not recorded unambiguously for this session');
    expect.soft(session).not.toHaveTextContent('Host Next Codex'); expect.soft(session).not.toHaveTextContent('stopped by you');
    expect.soft(within(session).getAllByText('Ended')).toHaveLength(1); expect.soft(within(session).getAllByText('Why')).toHaveLength(1);
    expect(chatPage).not.toHaveBeenCalled(); expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
  });
  it('keeps admitted current CLI identity when legacy optional provider fields are absent', async () => {
    const value = fixture(); value.providerLabel = 'Host Current Claude';
    value.settings = { ...value.settings!, provider: 'Host Next Codex', providerId: 'codex-cli' };
    delete value.providerLabel; delete value.settings.providerId;
    expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
    expect(value.providerId).toBe('claude-code');
    read.mockResolvedValue({ status: 'ok', value });
    render(<AgentDetails agent={agent} />);
    // This must be an admitted matching hydration, not a mismatched-provider refusal.
    await waitFor(() => expect(screen.getByTestId('details-setting-effort')).toHaveTextContent('High (default)'));
    expect(useChatStore.getState().agents[agent.id]).toMatchObject({ provider: 'claude-code', sessionId: 's1', nativeSessionId: 'n1', cliVersion: '1.2.3' });
    expect.soft(screen.getByTestId('details-setting-cli')).toHaveTextContent('claude-code 1.2.3');
    const toggle = screen.getByTestId('details-card-session-toggle');
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    expect.soft(screen.getByTestId('details-card-session')).toHaveTextContent('claude-code');
    expect.soft(screen.getByTestId('details-card-session')).not.toHaveTextContent('Host Next Codex');
    const next = screen.queryByTestId('details-setting-next-cli');
    expect.soft(next).not.toBeNull(); if (next) expect.soft(next).toHaveTextContent('Host Next Codex');
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
  });
  it('shows the actual current CLI separately from a changed inherited next-start provider', async () => {
    const value = fixture(); value.providerLabel = 'Host Current Claude';
    value.settings = { ...value.settings!, provider: 'Host Next Codex', providerId: 'codex-cli' };
    read.mockResolvedValue({ status: 'ok', value });
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host Current Claude 1.2.3');
    expect(screen.getByTestId('details-setting-next-cli')).toHaveTextContent('Host Next Codex');
    const toggle = screen.getByTestId('details-card-session-toggle');
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    expect(screen.getByTestId('details-card-session')).toHaveTextContent('Host Current Claude');
    expect(screen.getByTestId('details-card-session')).not.toHaveTextContent('Host Next Codex');
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
  });
  it('uses independently read initial provider facts outside a cut transcript only after matching runtime hydration', async () => {
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidence: evidence() } });
    chatPage.mockResolvedValue({ events: [{ v: 2, agentId: 'a1', sessionId: 's1', seq: 3000, ts: 3000, type: 'agent_message', data: { messageId: 'tail', text: 'Tail only' } }], readOnly: false, state: 'idle', truncated: true, displayRunId: 'runtime-a' });
    const localRead = vi.spyOn(window.clubhouse.chat, 'readTranscript');
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host CLI INITIAL_VERSION');
    expect(screen.getByTestId('details-setting-effort')).toHaveTextContent('High (default)');
    for (const id of ['subagents', 'session', 'skills-mcp']) {
      const toggle = await screen.findByTestId(`details-card-${id}-toggle`);
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    }
    expect(screen.getByText('Initial reviewer')).toBeInTheDocument();
    expect(screen.getByText('initial-skill')).toBeInTheDocument();
    expect(screen.getByText('INITIAL_MCP')).toBeInTheDocument();
    expect(screen.getByTestId('details-card-session')).toHaveTextContent('123 tokens');
    expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('Display reports from this runtime open are read separately');
    expect(localRead).not.toHaveBeenCalled(); localRead.mockRestore();
  });
  it.each(['unavailable', 'unsupported'] as const)('does not fall back to retained provider reports when a new host explicitly says %s', async (state) => {
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidenceState: state } });
    chatPage.mockResolvedValue(page('RETAINED_VERSION', { displayRunId: 'runtime-a' }));
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(useChatStore.getState().remoteReadReceipts[agent.id]?.displayRunId).toBe('runtime-a'));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(state === 'unavailable' ? 2 : 1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(screen.queryByText('Host CLI RETAINED_VERSION')).not.toBeInTheDocument();
    expect(screen.queryByText('host-skill')).not.toBeInTheDocument();
    expect(screen.queryByText('High (default)')).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(state === 'unavailable' ? 2 : 1);
    if (state === 'unavailable') expect(screen.getByRole('button', { name: 'Refresh provider reports' })).toBeInTheDocument();
  });
  it('does not promote an earlier display report after newer provider metadata arrives during hydration', async () => {
    const first = { ...fixture(), providerEvidence: evidence() };
    const nextEvidence = evidence(); nextEvidence.lastSeq = 4000; nextEvidence.values.cliVersion = 'NEW_VERSION'; nextEvidence.observedAt.cliVersion = 4000;
    read.mockResolvedValueOnce({ status: 'ok', value: first }).mockResolvedValue({ status: 'ok', value: { ...fixture(), providerEvidence: nextEvidence } });
    chatPage.mockResolvedValue(page('NEW_VERSION', { displayRunId: 'runtime-a', events: [{ v: 2, agentId: 'a1', sessionId: 's1', seq: 4000, ts: 4000, type: 'session_info', data: { cliVersion: 'NEW_VERSION' } }], readOnly: false }));
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host CLI NEW_VERSION');
    expect(screen.queryByText('Host CLI INITIAL_VERSION')).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(['replacement', 'missing-run-id', 'offline', 'error'] as const)('withholds initial provider reports across same-session %s hydration', async (mode) => {
    const first = { ...fixture(), providerEvidence: evidence() };
    read.mockResolvedValueOnce({ status: 'ok', value: first }).mockResolvedValue({ status: 'error' });
    chatPage.mockResolvedValue(page('TAIL_VERSION', { displayRunId: mode === 'missing-run-id' ? undefined : mode === 'replacement' ? 'runtime-b' : 'runtime-a', ...(mode === 'offline' ? { readOnly: true, state: 'sleeping' } : mode === 'error' ? { state: 'error' } : {}) }));
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Host CLI INITIAL_VERSION')).not.toBeInTheDocument();
    expect(screen.queryByText('initial-skill')).not.toBeInTheDocument();
    expect(screen.queryByText('INITIAL_MCP')).not.toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shows quick launch and current report fields without durable setup, next-wake settings or local reads', async () => {
    const value = fixture(); value.settings = null;
    for (const id of ['dispatcher', 'orchestrate'] as const) value.cards.find((c) => c.id === id)!.state = 'not-applicable';
    value.cards.find((c) => c.id === 'settings')!.rows = [{ label: 'CLI', value: 'Host CLI' }, { label: 'Requested model', value: 'launch-model' }, { label: 'Template', value: 'Host quick template' }];
    read.mockResolvedValue({ status: 'ok', value });
    render(<AgentDetails agent={{ ...agent, kind: 'quick' }} />);
    await waitFor(() => expect(screen.getByTestId('details-card-settings')).toHaveTextContent('High (default)'));
    const settings = within(screen.getByTestId('details-card-settings'));
    expect(settings.getByText('launch-model')).toBeInTheDocument();
    expect(settings.getByText('Host quick template')).toBeInTheDocument();
    expect(settings.getByText('Host CLI 1.2.3')).toBeInTheDocument();
    expect(settings.queryByText('Next wake')).not.toBeInTheDocument();
    expect(settings.queryByText('Instructions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-card-orchestrate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-card-dispatcher')).not.toBeInTheDocument();
    expect(window.clubhouse.annexClient.agentSettings).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
    expect(window.clubhouse.actions.list).not.toHaveBeenCalled();
  });
  it('keeps old-host quick unavailability explicit without durable settings or local fallback', async () => {
    read.mockResolvedValue({ status: 'unavailable' });
    render(<AgentDetails agent={{ ...agent, kind: 'quick' }} />);
    await waitFor(() => expect(screen.getByTestId('details-card-settings')).toHaveTextContent('This host does not share these details'));
    expect(window.clubhouse.annexClient.agentSettings).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
    expect(window.clubhouse.actions.list).not.toHaveBeenCalled();
  });
  it.each(['a1', 'remote||sat||'])('withholds malformed selected identity %s before any host or local fallback read', async (id) => {
    const settings = vi.fn();
    Object.assign(window.clubhouse.annexClient, { agentSettings: settings });
    render(<AgentDetails agent={{ ...agent, id }} />);
    expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('remote agent identity is unavailable');
    await act(async () => { await Promise.resolve(); });
    expect(read).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(chatPage).not.toHaveBeenCalled();
    expect(window.clubhouse.git.branchChanges).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
  });
  it.each(['running', 'sleeping', 'waking', 'error'] as const)('renders applicable host cards read-only for a %s agent with no local reads', async (status) => {
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(), status, running: status === 'running' } });
    render(<AgentDetails agent={{ ...agent, status }} />);
    await waitFor(() => expect(read).toHaveBeenCalledWith('sat', 'a1'));
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI'));
    for (const id of ['changes', 'dispatcher', 'orchestrate', 'connections', 'actions', 'skills-mcp', 'session', 'canvases']) {
      const toggle = screen.getByTestId(`details-card-${id}-toggle`);
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
      if (id === 'changes') await waitFor(() => expect(screen.getByTestId('details-card-changes')).toHaveTextContent('host-main'));
      else expect(within(screen.getByTestId(`details-card-${id}`)).getByText(`${id} evidence`)).toBeInTheDocument();
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
  it('shows verified host canvas identities with explicit navigation availability for snapshot omissions', async () => {
    const value = fixture();
    value.cards.find((c) => c.id === 'canvases')!.rows = [{ label: 'Host-only board', value: 'Home', canvas: { scope: 'app', canvasId: 'board', viewId: 'view' } }];
    read.mockResolvedValue({ status: 'ok', value });
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI'));
    fireEvent.click(screen.getByTestId('details-card-canvases-toggle'));
    expect(screen.getByTestId('details-canvas-row')).toHaveTextContent('Host-only board');
    expect(screen.getByTestId('details-canvas-row')).toBeDisabled();
    expect(screen.getByTestId('details-card-canvases')).toHaveTextContent('not in the host’s current shared snapshot');
    expect(window.clubhouse.canvas.getAgentCanvases).not.toHaveBeenCalled();
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
    value.outgoingWires = { source: 'selected-outgoing-binding-records', state: 'recorded', total: 1, omitted: 0, rows: [{ name: 'CURRENT_WIRE_RECORD', kind: 'agent' }] };
    value.cards.find((c) => c.id === 'skills-mcp')!.rows.push({ label: 'Clubhouse MCP', value: 'Connected · CURRENT_HANDSHAKE' });
    read.mockResolvedValueOnce({ status: 'ok', value }).mockResolvedValue({ status: 'error' });
    render(<AgentDetails agent={agent} />);
    await screen.findByText('Host CLI 1.2.3');
    fireEvent.click(screen.getByTestId('details-card-skills-mcp-toggle'));
    expect(screen.getByText('host-skill')).toBeInTheDocument();
    expect(screen.getByText('PROVIDER_MCP')).toBeInTheDocument();
    expect(screen.getByText('Recorded wire to CURRENT_WIRE_RECORD')).toBeInTheDocument();
    act(() => useChatStore.getState().applyEvent({ v: 2, agentId: agent.id, sessionId: 's1', seq: 4, ts: 4, type: 'session_ended', data: { reason: 'error' } }));
    expect(screen.queryByText('Host CLI 1.2.3')).not.toBeInTheDocument();
    expect(screen.queryByText('host-skill')).not.toBeInTheDocument();
    expect(screen.queryByText('PROVIDER_MCP')).not.toBeInTheDocument();
    expect(screen.queryByText(/CURRENT_HANDSHAKE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/CURRENT_WIRE_RECORD/)).not.toBeInTheDocument();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('Couldn’t read details'));
    expect(screen.queryByText(/CURRENT_HANDSHAKE/)).not.toBeInTheDocument();
    expect(screen.queryByText('Host CLI 1.2.3')).not.toBeInTheDocument();
  });
});

describe('selected host outgoing Wires consumer', () => {
  const selected = () => ({ ...fixture(), outgoingWires: { source: 'selected-outgoing-binding-records' as const, state: 'recorded' as const, total: 2, omitted: 1, rows: [{ name: 'SELECTED_HOST_WIRE', kind: 'browser' as const }] } });
  const openSkills = () => { const toggle = screen.getByTestId('details-card-skills-mcp-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle); };

  it.each(['running', 'sleeping'] as const)('shows selected %s host records independent of provider/handshake health and without fallback reads', async (status) => {
    const value = { ...selected(), status, running: status === 'running', sessionId: null, nativeSessionId: null };
    value.cards.find((c) => c.id === 'skills-mcp')!.rows = [];
    expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
    read.mockResolvedValue({ status: 'ok', value });
    render(<AgentDetails agent={{ ...agent, status }} />); await waitFor(() => expect(read).toHaveBeenCalled()); openSkills();
    await screen.findByText('Recorded wire to SELECTED_HOST_WIRE');
    const wires = screen.getByRole('region', { name: 'Wires' });
    expect(wires).toHaveTextContent('browser'); expect(wires).toHaveTextContent('1 additional outgoing binding records omitted');
    expect(wires).toHaveTextContent('do not establish health, reachability, authorization or a live connection');
    expect(within(wires).queryByRole('button')).not.toBeInTheDocument(); expect(within(wires).queryByRole('link')).not.toBeInTheDocument();
    expect(window.clubhouse.mcpBinding.getAgentConnection).not.toHaveBeenCalled(); expect(window.clubhouse.managed.getSetup).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1); expect(chatPage).not.toHaveBeenCalled();
  });

  it.each(['offline', 'snapshot-unavailable', 'denied', 'dispatcher-role', 'quick-role'] as const)('withholds prior wire records across %s continuity changes', async (mode) => {
    read.mockResolvedValue({ status: 'ok', value: selected() });
    const view = render(<AgentDetails agent={agent} />); await waitFor(() => expect(read).toHaveBeenCalled()); openSkills();
    await screen.findByText('Recorded wire to SELECTED_HOST_WIRE');
    if (mode === 'offline') act(() => satellite({ state: 'disconnected' }));
    if (mode === 'snapshot-unavailable') act(() => satellite({ snapshotUnavailable: true }));
    if (mode === 'denied') { read.mockResolvedValue({ status: 'forbidden' }); act(() => satellite()); }
    if (mode === 'dispatcher-role') act(() => satellite({ snapshot: { dispatcher: { agent: { id: 'a1' } } } }));
    if (mode === 'quick-role') view.rerender(<AgentDetails agent={{ ...agent, kind: 'quick' }} />);
    expect(screen.queryByText(/SELECTED_HOST_WIRE/)).not.toBeInTheDocument();
    if (mode === 'snapshot-unavailable' || mode === 'denied') {
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
      expect(screen.queryByText(/SELECTED_HOST_WIRE/)).not.toBeInTheDocument();
    }
    expect(window.clubhouse.mcpBinding.getAgentConnection).not.toHaveBeenCalled(); expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
  });

  it('does not replay a late previous-host wire record into a different host with the same native agent id', async () => {
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ status: 'forbidden' });
    const view = render(<AgentDetails agent={agent} />); await waitFor(() => expect(read).toHaveBeenCalled());
    act(() => satellite({ id: 'other-host' }));
    view.rerender(<AgentDetails agent={{ ...agent, id: 'remote||other-host||a1', projectId: 'remote||other-host||p1' }} />);
    await act(async () => { finish({ status: 'ok', value: selected() }); });
    openSkills(); await waitFor(() => expect(read).toHaveBeenCalledWith('other-host', 'a1'));
    expect(screen.queryByText(/SELECTED_HOST_WIRE/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Recorded outgoing wires' })).not.toBeInTheDocument();
    expect(window.clubhouse.mcpBinding.getAgentConnection).not.toHaveBeenCalled();
  });
});

it('shows independently known host Settings fields alongside explicit unavailable next-wake evidence', async () => {
  const value = fixture(); value.settings = null;
  const c = value.cards.find((card) => card.id === 'settings')!;
  c.state = 'error'; c.rows = [{ label: 'Next start model', value: 'HOST_SAVED_MODEL' }, { label: 'Next wake', value: 'Unavailable from host settings' }]; c.notes = ['Unavailable settings are not inferred from this machine.'];
  read.mockResolvedValue({ status: 'ok', value }); render(<AgentDetails agent={agent} />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  const toggle = screen.getByTestId('details-card-settings-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  const card = screen.getByTestId('details-card-settings');
  await waitFor(() => expect(card).toHaveTextContent('HOST_SAVED_MODEL'));
  expect(card).toHaveTextContent('Unavailable from host settings'); expect(card).toHaveTextContent('Unavailable settings are not inferred from this machine.');
  expect(window.clubhouse.annexClient.agentSettings).not.toHaveBeenCalled(); expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
});

it('keeps withheld request text out of visible, title and accessibility paths and never falls back to cached raw tasks', async () => {
  useHelperStartRequestStore.setState({ requests: { cached: { requestId: 'cached', projectPath: 'PRIVATE_LOCAL_PROJECT', orchestratorId: agent.id, orchestratorName: 'Remote', args: { name: 'PRIVATE_CACHED_HELPER', task: 'PRIVATE_CACHED_TASK' }, createdAt: '2026-11-19T00:00:00Z', expiresAt: '2026-11-20T00:00:00Z' } } });
  const value = fixture(), c = value.cards.find((card) => card.id === 'orchestrate')!;
  c.rows = [{ label: 'Waiting to start', value: 'Selected helper · awaiting approval' }, { label: 'Task', value: 'Task withheld (conservative display policy)' }, { label: 'Requested / expires', value: 'HOST_CREATED · HOST_EXPIRES' }, { label: 'Task', value: 'Review visible changes' }];
  c.notes = ['Other request fields remain independent.']; read.mockResolvedValue({ status: 'ok', value });
  const { container } = render(<AgentDetails agent={agent} />); await waitFor(() => expect(read).toHaveBeenCalled());
  const toggle = screen.getByTestId('details-card-orchestrate-toggle'); if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  const card = screen.getByTestId('details-card-orchestrate'); await waitFor(() => expect(card).toHaveTextContent('Selected helper'));
  expect(card).toHaveTextContent('Task withheld (conservative display policy)'); expect(card).toHaveTextContent('HOST_CREATED · HOST_EXPIRES'); expect(card).toHaveTextContent('Review visible changes');
  expect(container.innerHTML).not.toMatch(/PRIVATE_CACHED|PRIVATE_LOCAL/); expect(screen.queryByTestId('helper-request-task')).not.toBeInTheDocument(); expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
});

describe('real-chat Dispatcher private Other machines admission', () => {
  const privateSnapshot = (peer = 'PRIVATE_OLD_PEER') => ({ dispatcher: { agent: { ...agent, id: 'a1', projectId: '__dispatcher__' } }, dispatcherPresence: { remotes: [
    { machineId: peer, machineName: peer, dispatcherName: 'Private host peer', label: `Private host peer on ${peer}`, address: null, state: 'online', link: { state: 'active' } },
  ] } });
  const openPeers = () => {
    const toggle = screen.getByTestId('details-card-other-machines-toggle');
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  };
  it('withholds denied data across retained clone, remount and regrant before an actual fresh snapshot', async () => {
    const snap = privateSnapshot();
    satellite({ snapshot: snap, snapshotReceipt: 'positive-a', connectionGeneration: 0 });
    let view = render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI'));
    openPeers(); expect(screen.getByTestId('other-machine-PRIVATE_OLD_PEER')).toBeInTheDocument();
    read.mockResolvedValue({ status: 'forbidden' });
    // A denied current read blocks even a still-positive retained marker before its main invalidation arrives.
    act(() => satellite({ snapshot: JSON.parse(JSON.stringify(snap)), snapshotReceipt: 'positive-a', connectionGeneration: 0 }));
    await waitFor(() => expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('does not allow this details read'));
    expect(screen.queryByTestId('other-machine-PRIVATE_OLD_PEER')).not.toBeInTheDocument();
    act(() => satellite({ snapshot: JSON.parse(JSON.stringify(snap)), snapshotReceipt: undefined, connectionGeneration: 0 }));
    view.unmount(); view = render(<AgentDetails agent={agent} />); openPeers();
    expect(screen.queryByTestId('other-machine-PRIVATE_OLD_PEER')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('remote-details-freshness')).toHaveTextContent('does not allow this details read'));
    read.mockResolvedValue({ status: 'ok', value: fixture() });
    act(() => satellite({ snapshot: JSON.parse(JSON.stringify(snap)), snapshotReceipt: undefined, connectionGeneration: 0 }));
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI'));
    expect(screen.queryByTestId('other-machine-PRIVATE_OLD_PEER')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-other-machines')).toHaveTextContent('Earlier private peers are withheld');
    act(() => satellite({ snapshot: privateSnapshot('PRIVATE_FRESH_PEER'), snapshotReceipt: 'fresh-b', connectionGeneration: 0 }));
    await screen.findByTestId('other-machine-PRIVATE_FRESH_PEER');
    expect(screen.queryByTestId('other-machine-PRIVATE_OLD_PEER')).not.toBeInTheDocument();
  });

  it.each(['needsPairing', 'receipt', 'offline', 'snapshotUnavailable', 'paused'] as const)('hides current private peers on %s, including an unchanged/retained snapshot and successful stale mock Details', async (mode) => {
    const snap = privateSnapshot();
    satellite({ snapshot: snap, snapshotReceipt: 'positive-a' });
    const presence = vi.spyOn(window.clubhouse.dispatcher, 'getPresence').mockResolvedValue({ remotes: [{ machineId: 'LOCAL_FALLBACK', machineName: 'Local', address: null, dispatcherName: 'Local', label: 'Local', state: 'online', link: { state: 'active' } }] });
    render(<AgentDetails agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Host CLI')); openPeers();
    expect(screen.getByTestId('other-machine-PRIVATE_OLD_PEER')).toBeInTheDocument();
    act(() => satellite({ snapshot: mode === 'paused' ? { ...snap, sessionPaused: true } : snap, snapshotReceipt: mode === 'receipt' ? undefined : 'positive-a',
      ...(mode === 'needsPairing' && { needsPairing: true }), ...(mode === 'offline' && { state: 'disconnected' }), ...(mode === 'snapshotUnavailable' && { snapshotUnavailable: true }) }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(screen.queryByTestId('other-machine-PRIVATE_OLD_PEER')).not.toBeInTheDocument();
    expect(screen.queryByTestId('other-machine-LOCAL_FALLBACK')).not.toBeInTheDocument();
    expect(screen.getByTestId('details-card-other-machines')).toHaveTextContent('Earlier private peers are withheld');
    expect(presence).not.toHaveBeenCalled();
  });
});
