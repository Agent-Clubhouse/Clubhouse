import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { RemoteSessionHistoryBinding } from '../../../../shared/remote-session-history';
import { DISPATCHER_PROJECT_ID } from '../../../../shared/dispatcher-types';
import { remoteTranscriptRevision, useChatStore } from '../../../stores/chatStore';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { RemoteSessionHistory } from './RemoteSessionHistory';
const agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', name: 'Remote', kind: 'durable', status: 'running' } as Agent;
const binding: RemoteSessionHistoryBinding = { version: 1, projectId: 'p1', agentId: 'a1', sessionId: 's1', providerId: 'claude-code', driver: 'claude_agent_sdk', nativeSessionId: 'n1', displayRunId: 'run-a', startSeq: 1, subagents: 'full' };
const request = vi.fn();
let snapshot: object;
const event = (seq: number, type = 'notice', data: object = { level: 'info', message: 'ordinary event' }) => ({ v: 2, agentId: 'a1', sessionId: 's1', seq, ts: seq, type, data });
const details = (b = binding) => ({ agentId: b.agentId, providerId: b.providerId, nativeSessionId: b.nativeSessionId, sessionId: b.sessionId, running: true,
  providerEvidence: { version: 1, agentId: b.agentId, providerId: b.providerId, sessionId: b.sessionId, nativeSessionId: b.nativeSessionId, driver: b.driver,
    runId: b.displayRunId, startSeq: b.startSeq, values: { capabilities: { subagents: b.subagents } } } }) as RemoteAgentDetails;
function receipt(b: RemoteSessionHistoryBinding | null = binding, cursor: number | null | undefined = 206) {
  useChatStore.setState({ remoteReadReceipts: { [agent.id]: { revision: remoteTranscriptRevision(agent.id), snapshot, sessionId: 's1', live: true, state: 'idle', truncated: true, displayRunId: b?.displayRunId, historyBinding: b ?? undefined, nextBeforeSeq: cursor } } });
}
const page = (events: unknown[] = [event(20, 'subagent', { subagentId: 'child', name: 'Earlier child', status: 'completed' })], nextBeforeSeq: number | null = 6, b = binding) => ({
  historyBinding: b, agentId: b.agentId, sessionId: b.sessionId, currentSessionId: b.sessionId, displayRunId: b.displayRunId, readOnly: false, state: 'idle', events, truncated: nextBeforeSeq !== null, nextBeforeSeq,
});
const show = (b = binding, selected = agent) => render(<RemoteSessionHistory agent={selected} details={details(b)} ready generation={0} />);
beforeEach(() => {
  useChatStore.getState().reset(agent.id);
  snapshot = {};
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot }] as never });
  receipt();
  request.mockResolvedValue(page());
  Object.assign(window.clubhouse.annexClient, { chatPage: request, controllerChatPage: vi.fn(), chatCommand: vi.fn() });
  window.clubhouse.chat.readTranscript = vi.fn();
});
it('reads older reports beyond a 2000-event tail only on demand, reaches the 65th child/name and stops honestly', async () => {
  const archive = Array.from({ length: 2205 }, (_, i) => event(i + 1));
  for (let i = 0; i < 65; i++) archive[9 + i] = event(10 + i, 'subagent', { subagentId: `child-${i}`, name: `Archived child ${i}`, status: 'completed', toolCount: 0, usage: { total: 0 } });
  archive[79] = event(80, 'tool_call', { toolCallId: 'tool', subagentId: 'child-0', kind: 'read', title: 'earlier activity', status: 'completed', content: [] });
  archive[80] = event(81, 'tool_call_update', { toolCallId: 'tool', status: 'completed', durationMs: 42 });
  archive[81] = event(82, 'session_info', { nativeSessionId: 'n1', providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'n1', names: Array.from({ length: 65 }, (_, i) => `Archived skill ${i}`) } });
  archive[1] = event(2, 'session_info', { nativeSessionId: 'n1', providerInventory: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'n1', skills: [] } });
  request.mockImplementation(async (_host, _id, query) => {
    const eligible = archive.filter((e) => e.seq < query.beforeSeq);
    const events = eligible.slice(-query.limit);
    return page(events, eligible.length > events.length ? events[0].seq : null);
  });
  const currentChat = useChatStore.getState().agents;
  show();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read older session history' }));
  await waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith('sat', 'a1', { beforeSeq: 206, limit: 200 }));
  await screen.findByText(/Child report: Archived child 0/);
  expect(screen.queryByText(/Child report: Archived child 64/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next reports' }));
  expect(screen.getByText(/Child report: Archived child 64/)).toHaveTextContent('0 tools · 0 tokens');
  expect(screen.getByText(/Child activity: child-0/)).toBeInTheDocument();
  expect(screen.getByText(/42 ms/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next names' }));
  expect(screen.getByText('Archived skill 64')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Read older page' }));
  await screen.findByText('Archived inventory skills: explicitly empty.');
  expect(screen.getByText('Archived model-visible MCP tools: not reported in this event.')).toBeInTheDocument();
  expect(screen.getByText(/No earlier events were reported within this runtime open/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Read older page' })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(2);
  expect(useChatStore.getState().agents).toBe(currentChat);
  expect(window.clubhouse.chat.readTranscript).not.toHaveBeenCalled();
  expect(window.clubhouse.annexClient.controllerChatPage).not.toHaveBeenCalled();
  expect(window.clubhouse.annexClient.chatCommand).not.toHaveBeenCalled();
});
it.each(['full', 'ids_only', 'none'] as const)('preserves the %s child capability', async (mode) => {
  const selected = { ...binding, subagents: mode };
  receipt(selected);
  request.mockResolvedValue(page([event(20, 'subagent', { subagentId: 'child-id', name: 'CAPABILITY_HIDDEN_NAME', status: 'completed' })], null, selected));
  show(selected);
  fireEvent.click(screen.getByRole('button', { name: 'Read older session history' }));
  await screen.findByTestId('remote-history-reports');
  if (mode === 'full') expect(screen.getByText(/CAPABILITY_HIDDEN_NAME/)).toHaveTextContent('completed');
  else expect(screen.queryByText(/CAPABILITY_HIDDEN_NAME/)).not.toBeInTheDocument();
  if (mode === 'ids_only') expect(screen.getByText(/Child thread: child-id/)).toHaveTextContent('Name and status are not reported');
  if (mode === 'none') expect(screen.getByText(/does not expose child details/)).toBeInTheDocument();
});
it('withholds the last archived page after denial without exposing raw host errors', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Read older session history' }));
  await screen.findByText(/Earlier child/);
  request.mockRejectedValueOnce(new Error('PRIVATE_HOST_ERROR'));
  fireEvent.click(screen.getByRole('button', { name: 'Read older page' }));
  await screen.findByText(/Previous archived evidence is withheld/);
  expect(screen.queryByText(/Earlier child|PRIVATE_HOST_ERROR/)).not.toBeInTheDocument();
});
it('preserves malformed/foreign/shortened reports as partial instead of treating them as empty inventories', async () => {
  request.mockResolvedValue(page([
    event(20, 'session_info', { providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'wrong-native', names: ['FOREIGN_SKILL'] } }),
    event(21, 'session_info', { providerInventory: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'n1', skills: null } }),
    event(22, 'session_info', { providerSkills: { provider: 'claude-code', driver: 'claude_agent_sdk', source: 'system/init', nativeSessionId: 'n1', names: [] }, truncated: { originalBytes: 999999 } }),
  ], null));
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Read older session history' }));
  await screen.findByText('Archived skill names: unavailable or malformed.');
  expect(screen.getByText('Archived inventory skills: unavailable or malformed.')).toBeInTheDocument();
  expect(screen.getByText(/This archived event was shortened/)).toBeInTheDocument();
  expect(screen.queryByText(/FOREIGN_SKILL|explicitly empty/)).not.toBeInTheDocument();
});
it.each([true, false])('distinguishes a known zero usage report from unknown totals/scope, known=%s', async (known) => {
  request.mockResolvedValue(page([event(20, 'usage', known ? { scope: 'session', tokens: { total: 0 }, costUsd: 0 } : { scope: 'malformed', tokens: {} })], null));
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Read older session history' }));
  await screen.findByTestId('remote-history-reports');
  expect(screen.getByTestId('remote-history-reports')).toHaveTextContent(known ? 'Usage report: session · 0 tokens · $0' : 'Usage report: scope not reported · token total not reported');
});
it.each(['host', 'project', 'session', 'provider', 'native', 'same-native reopen', 'offline', 'snapshot', 'denied Details'] as const)('discards a late archive page after %s', async (change) => {
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = show();
  fireEvent.click(screen.getByRole('button', { name: 'Read older session history' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const next = { ...binding };
  let selected = agent, ready = true;
  if (change === 'host') selected = { ...agent, id: 'remote||other||a1', projectId: 'remote||other||p1' };
  if (change === 'project') selected = { ...agent, projectId: 'remote||sat||p2' };
  if (change === 'session') next.sessionId = 's2';
  if (change === 'provider') next.providerId = 'copilot';
  if (change === 'native') next.nativeSessionId = 'n2';
  if (change === 'same-native reopen') { next.displayRunId = 'run-b'; next.startSeq = 100; act(() => receipt(next)); }
  if (change === 'offline') act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'disconnected', snapshot }] as never }));
  if (change === 'snapshot') act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: {} }] as never }));
  if (change === 'denied Details') ready = false;
  view.rerender(<RemoteSessionHistory agent={selected} details={details(next)} ready={ready} generation={0} />);
  await act(async () => finish(page()));
  expect(screen.queryByText(/Earlier child/)).not.toBeInTheDocument();
  expect(screen.queryByTestId('remote-history-reports')).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(['old host', 'Quick', 'Dispatcher', 'raw id'] as const)('keeps %s partial without broadening reads', async (mode) => {
  if (mode === 'old host') receipt(null);
  const selected = mode === 'Quick' ? { ...agent, kind: 'quick' as const } : mode === 'Dispatcher' ? { ...agent, projectId: `remote||sat||${DISPATCHER_PROJECT_ID}` } : mode === 'raw id' ? { ...agent, id: 'a1' } : agent;
  show(binding, selected);
  expect(screen.queryByRole('button', { name: 'Read older session history' })).not.toBeInTheDocument();
  expect(screen.getByText(/Earlier facts remain unavailable/)).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});
