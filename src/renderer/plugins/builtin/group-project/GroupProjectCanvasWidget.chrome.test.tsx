import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent } from '../../../../shared/types';

// The card is compact below 500px and the three-pane view above it.
let widgetWidth = 300;
class SizedResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb([{ target, contentRect: { width: widgetWidth, height: 600 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: SizedResizeObserver, writable: true });

const setPolling = vi.fn(async () => {});
const update = vi.fn(async () => {});
const deleteTopic = vi.fn(async () => true);
let admins: string[] = [];

vi.mock('./useGroupProjectContext', () => ({
  useGroupProjectContext: () => ({
    isRemote: false,
    satelliteId: null,
    project: { id: 'gp1', name: 'Launch', description: 'Ship the launch', instructions: 'Be brief', metadata: { admins } },
    members: [
      { agentId: 'a1', agentName: 'curious-tapir' },
      { agentId: 'a2', agentName: 'bold-falcon' },
    ],
    loaded: true,
    loadProjects: vi.fn(async () => {}),
    update,
    setPolling,
    fetchDigest: vi.fn(async () => [{ topic: 'general', messageCount: 3, newMessageCount: 1, latestTimestamp: '2026-10-18T10:00:00.000Z' }]),
    fetchTopicMessages: vi.fn(async () => []),
    fetchAllMessages: vi.fn(async () => []),
    injectMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => true),
    deleteTopic,
    setTopicProtection: vi.fn(async () => true),
    clearAllMessages: vi.fn(async () => ({ removed: 0 })),
    estimateTrim: vi.fn(async () => ({ wouldRemove: 0 })),
  }),
}));

vi.mock('../../../stores/mcpSettingsStore', () => ({
  useMcpSettingsStore: (sel: (s: unknown) => unknown) => sel({ enabled: true }),
}));

vi.mock('../../../hooks/useRemoteProject', () => ({
  useRemoteProject: () => ({ isRemote: false, satelliteId: null }),
}));

let confirmAnswer = true;
const showConfirmDialog = vi.fn((_message: string) => ({ promise: Promise.resolve(confirmAnswer), cleanup: () => {} }));
vi.mock('../../PluginDialog', () => ({
  showConfirmDialog: (message: string) => showConfirmDialog(message),
  showApprovalDialog: () => ({ promise: Promise.resolve(null), cleanup: () => {} }),
}));

import { GroupProjectCanvasWidget, POLLING_HINT } from './GroupProjectCanvasWidget';
import { useAgentStore } from '../../../stores/agentStore';
import { DOT_LABEL, type AgentDot } from '../../../features/agents/agent-status';

const tapir: Agent = { id: 'a1', projectId: 'p1', name: 'curious-tapir', kind: 'durable', status: 'running', color: 'teal' };

function renderWidget() {
  return render(
    <GroupProjectCanvasWidget
      widgetId="w1"
      api={{ context: { mode: 'app', projectId: undefined }, annex: {} } as never}
      metadata={{ groupProjectId: 'gp1' }}
      onUpdateMetadata={vi.fn()}
      size={{ width: widgetWidth, height: 600 }}
      {...({} as never)}
    />,
  );
}

beforeEach(() => {
  widgetWidth = 300;
  admins = [];
  confirmAnswer = true;
  vi.clearAllMocks();
  useAgentStore.setState({ agents: { a1: tapir }, agentDetailedStatus: {} } as never);
});

describe('group project card (compact)', () => {
  it('switches polling with the shared switch, labelled Polling', async () => {
    renderWidget();
    expect(screen.getByText('2 agents')).toBeInTheDocument();
    const polling = screen.getByRole('switch', { name: 'Polling' });
    expect(polling).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(polling);
    expect(setPolling).toHaveBeenCalledWith('gp1', true);
  });

  it('lists members with an avatar row, the lead word and a status dot plus one word', () => {
    admins = ['a1'];
    renderWidget();
    const rows = screen.getAllByTestId('group-project-member');
    expect(rows).toHaveLength(2);
    const tapirRow = rows[0];
    expect(within(tapirRow).getByText('Lead')).toBeInTheDocument();
    const dot = tapirRow.querySelector('[data-dot]')!;
    expect(within(tapirRow).getByText(DOT_LABEL[dot.getAttribute('data-dot') as AgentDot])).toBeInTheDocument();
    // An agent this window doesn't have (e.g. remote) shows no status rather than a guess.
    expect(rows[1].querySelector('[data-dot]')).toBeNull();
  });

  it('makes a member a project lead from its star button', async () => {
    renderWidget();
    const falconRow = screen.getAllByTestId('group-project-member')[1];
    const star = within(falconRow).getByRole('button', { name: 'Project lead' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);
    expect(update).toHaveBeenCalledWith('gp1', { metadata: { admins: ['a2'] } });
  });

  it('keeps the star button\'s name fixed and says lead or not with aria-pressed', () => {
    admins = ['a1'];
    renderWidget();
    const stars = screen.getAllByRole('button', { name: 'Project lead' });
    expect(stars.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });

  it('reads a member\'s status once: the word, not also the dot', () => {
    renderWidget();
    const row = screen.getAllByTestId('group-project-member')[0];
    const dot = row.querySelector('[data-dot]')!;
    const word = DOT_LABEL[dot.getAttribute('data-dot') as AgentDot];
    expect(dot.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(row).queryByRole('img', { name: word })).toBeNull();
    expect(within(row).getByText(word)).toBeInTheDocument();
  });

  it('toggles polling from its label too, and explains polling in a tooltip', async () => {
    renderWidget();
    const label = screen.getByText('Polling');
    expect(label.tagName).toBe('LABEL');
    // The tooltip first: the shared Tooltip stays closed after a click until the pointer leaves.
    await userEvent.hover(label);
    expect(await screen.findByText(POLLING_HINT, {}, { timeout: 2_000 })).toBeInTheDocument();
    await userEvent.click(label);
    expect(setPolling).toHaveBeenCalledWith('gp1', true);
  });

  it('opens the broadcast dialog on the shared Modal', async () => {
    renderWidget();
    await userEvent.click(screen.getByRole('button', { name: 'Broadcast message' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Broadcast message')).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: 'Include project instructions' })).toBeInTheDocument();
  });
});

describe('group project card (expanded)', () => {
  beforeEach(() => { widgetWidth = 900; });

  it('asks through the shared confirm dialog before deleting a topic', async () => {
    renderWidget();
    await screen.findByText('general');
    expect(screen.getByTestId('group-project-topic-unread')).toHaveTextContent('1 new');
    confirmAnswer = false;
    await userEvent.click(screen.getByRole('button', { name: 'Delete topic' }));
    expect(showConfirmDialog).toHaveBeenCalledTimes(1);
    expect(deleteTopic).not.toHaveBeenCalled();
    confirmAnswer = true;
    await userEvent.click(screen.getByRole('button', { name: 'Delete topic' }));
    await waitFor(() => expect(deleteTopic).toHaveBeenCalledWith('gp1', 'general'));
  });

  it('keeps the protect button\'s name fixed, with aria-pressed for its state', async () => {
    renderWidget();
    await screen.findByText('general');
    const protect = screen.getByRole('button', { name: 'Protect topic' });
    expect(protect).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the polling switch in the header', () => {
    renderWidget();
    expect(screen.getByRole('switch', { name: 'Polling' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retention settings' })).toHaveAttribute('aria-pressed', 'false');
  });
});
