import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { REMOTE_DETAILS_CARD_IDS } from '../../../../shared/remote-agent-details';
import { SleepingAgent } from '../SleepingAgent';
import { RemoteAgentDetailsView } from '../details/RemoteAgentDetailsView';
import { useAgentDetailsStore } from '../details/detailsStore';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useAgentStore } from '../../../stores/agentStore';
vi.mock('../SleepingMascots', () => ({ SleepingMascot: () => <div /> }));
const read = vi.fn(), transcript = vi.fn();
const agent: Agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', name: 'Remote parent', kind: 'durable', status: 'sleeping', color: 'blue' };
const fixture = (): RemoteAgentDetails => ({ version: 1, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'codex-cli', running: false, status: 'sleeping', spawnedAt: null, sessionId: 'retained-session', nativeSessionId: null,
  settings: { version: 1, agentId: 'a1', readOnly: true, provider: 'Host CLI', model: 'Host model', runtime: 'terminal', access: 'Ask first', executionPolicy: 'defaults', autoSleep: null, context: null, setup: { state: 'ok', managed: false, template: null, instructions: 'None', skills: null, mcps: [] } },
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, summary: id === 'orchestrate' ? 'on' : 'Host card', state: 'ok', rows: id === 'orchestrate' ? [{ label: 'Orchestration', value: 'On' }] : [], notes: [], omitted: 0, observedAt: 1 })), helperPages: 1,
  helperPage: { version: 1, source: 'selected-direct-helpers', state: 'ok', offset: 0, next: null, total: 1, liveCount: 1, disposedCount: 0, pendingCount: 1,
    rows: [{ key: 'helper', name: 'Host helper', projectName: 'Host project', status: 'not-running', statusSource: 'unknown', branch: 'work', failure: 'unknown', disposedAt: null, work: { state: 'recorded', text: '2 uncommitted' } }],
    pending: [{ key: 'request', name: 'Pending helper', task: 'Read-only pending task', warning: null, createdAt: '2026-11-20T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }], notes: [] } });
function satellite(state = 'connected', snapshot = {}) { useAnnexClientStore.setState({ satellites: [{ id: 'sat', alias: 'Host', state, snapshot }] as never }); }
beforeEach(() => {
  useAgentDetailsStore.setState({ open: false, focus: null }); useProjectStore.setState({ projects: [], activeProjectId: null }); useAgentStore.setState({ agents: { [agent.id]: agent }, agentIcons: {}, sessionNamePromptFor: null });
  satellite(); read.mockReset().mockResolvedValue({ status: 'ok', value: fixture() }); transcript.mockReset().mockResolvedValue({ events: [], readOnly: true });
  Object.assign(window.clubhouse.annexClient, { agentDetails: read, chatPage: transcript, agentSettings: vi.fn(async () => ({ status: 'unavailable' })) });
  for (const [object, method] of [[window.clubhouse.agent, 'listDurable'], [window.clubhouse.agent, 'getDurableConfig'], [window.clubhouse.agent, 'getOrchestrationPolicy'], [window.clubhouse.git, 'info'], [window.clubhouse.actions, 'list']] as const) Object.assign(object, { [method]: vi.fn() });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('shows selected read-only helpers and pending rows inline without hydrating transcript or local state', async () => {
  render(<SleepingAgent agent={agent} details />);
  expect(await screen.findByText('Host helper')).toBeInTheDocument(); expect(screen.getByTestId('sleeping-remote-orchestration')).toBeInTheDocument(); expect(screen.getByText('Pending helper')).toBeInTheDocument(); expect(read).toHaveBeenCalledExactlyOnceWith('sat', 'a1'); expect(transcript).not.toHaveBeenCalled();
  expect(window.clubhouse.agent.listDurable).not.toHaveBeenCalled(); expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled(); expect(window.clubhouse.agent.getOrchestrationPolicy).not.toHaveBeenCalled(); expect(window.clubhouse.actions.list).not.toHaveBeenCalled(); expect(window.clubhouse.git.info).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
});
it('keeps one read owner while moving between hidden Details inline and the Details column', async () => {
  read.mockResolvedValue({ status: 'ok', value: { ...fixture(), sessionId: null } }); render(<SleepingAgent agent={agent} details />); await screen.findByText('Host helper');
  act(() => useAgentDetailsStore.setState({ open: true })); expect(await screen.findByTestId('agent-details')).toBeInTheDocument(); expect(screen.queryByTestId('sleeping-remote-orchestration')).not.toBeInTheDocument();
  act(() => useAgentDetailsStore.setState({ open: false })); expect(await screen.findByTestId('sleeping-remote-orchestration')).toBeInTheDocument(); await new Promise((resolve) => setTimeout(resolve, 200)); expect(read).toHaveBeenCalledTimes(1);
});
it('withholds old helper facts across disconnect, reconnect and subsequent refusal', async () => {
  render(<SleepingAgent agent={agent} details />); await screen.findByText('Host helper');
  act(() => satellite('disconnected')); expect(screen.queryByText('Host helper')).not.toBeInTheDocument(); expect(screen.getByTestId('details-card-orchestrate')).toHaveTextContent('Host offline. Reconnect to read helpers.');
  read.mockResolvedValue({ status: 'forbidden' }); act(() => satellite()); await waitFor(() => expect(screen.getByTestId('details-card-orchestrate')).toHaveTextContent('The host does not allow this helper read.')); expect(screen.queryByText('Host helper')).not.toBeInTheDocument();
});
it('does not read when agent/project host identities disagree', async () => {
  render(<SleepingAgent agent={{ ...agent, projectId: 'remote||other||p1' }} details />); expect(screen.getByText(/do not identify the same host/)).toBeInTheDocument(); await new Promise((resolve) => setTimeout(resolve, 200)); expect(read).not.toHaveBeenCalled();
});
it('ignores an old parent read that completes after selection changed', async () => {
  let finish!: (result: unknown) => void; read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<SleepingAgent agent={agent} details />); await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  read.mockResolvedValue({ status: 'forbidden' }); view.rerender(<SleepingAgent agent={{ ...agent, id: 'remote||sat||other', name: 'Other parent' }} details />);
  await act(async () => finish({ status: 'ok', value: fixture() })); await waitFor(() => expect(screen.getByTestId('details-card-orchestrate')).toHaveTextContent('The host does not allow this helper read.')); expect(screen.queryByText('Host helper')).not.toBeInTheDocument();
});

it('does not admit inline helper reads while the current host snapshot is unavailable', async () => {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: {}, snapshotUnavailable: true }] as never });
  render(<SleepingAgent agent={agent} details />); expect(screen.getByText(/host snapshot is unavailable/)).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 200)); expect(read).not.toHaveBeenCalled(); expect(screen.queryByText('Host helper')).not.toBeInTheDocument();
});

it('requires a fresh read after visibility was disabled instead of reviving retained helper facts', async () => {
  const target = document.createElement('div'); document.body.appendChild(target);
  const view = render(<RemoteAgentDetailsView agent={agent} helpersOnly readEnabled inlineTarget={target} />);
  try {
    await screen.findByText('Host helper'); view.rerender(<RemoteAgentDetailsView agent={agent} helpersOnly readEnabled={false} inlineTarget={target} />); expect(screen.queryByText('Host helper')).not.toBeInTheDocument();
    let finish!: (value: unknown) => void; read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    view.rerender(<RemoteAgentDetailsView agent={agent} helpersOnly readEnabled inlineTarget={target} />); expect(screen.queryByText('Host helper')).not.toBeInTheDocument(); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => finish({ status: 'forbidden' })); expect(screen.queryByText('Host helper')).not.toBeInTheDocument(); expect(screen.getByTestId('details-card-orchestrate')).toHaveTextContent('The host does not allow this helper read.');
  } finally { view.unmount(); target.remove(); }
});
