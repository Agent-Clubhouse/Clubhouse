/**
 * Screen-reader announcements and the delivery-failed state of the
 * setup-changed bar and the Setup card (#2819). The live regions stay
 * mounted, so a change of their text is announced.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../shared/types';
import type { ManagedAgentStatus } from '../../../shared/managed-agents-types';
import { useProjectStore } from '../../stores/projectStore';
import { SettingsCard } from '../agents/details/SettingsCard';
import { useAgentDetailsStore } from '../agents/details/detailsStore';
import { resetSetupBarDismissals, SetupChangedBar } from './SetupChangedBar';
import { resetPendingRestarts } from './restart';

const agent: Agent = {
  id: 'a1', projectId: 'p1', name: 'release-lead', kind: 'durable', status: 'running', color: 'teal',
  orchestrator: 'claude-code', model: 'claude-opus-5-5',
};
const m = () => window.clubhouse.managed;

function status(over: Partial<ManagedAgentStatus> = {}): ManagedAgentStatus {
  return { managed: true, running: true, waiting: true, changes: ['Rules was edited'], deliveredAt: '2026-11-07T10:00:00Z', cliChanged: false, ...over };
}

/** The status main answers, changed by the test, with a way to tell listeners. */
function liveStatus(initial: ManagedAgentStatus) {
  let current = initial;
  const listeners: Array<() => void> = [];
  vi.spyOn(m(), 'status').mockImplementation(async () => ({ ok: true, value: current }) as never);
  vi.spyOn(m(), 'onChanged').mockImplementation((l: () => void) => { listeners.push(l); return () => {}; });
  return { set: (next: ManagedAgentStatus) => { current = next; act(() => listeners.forEach((l) => l())); } };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetSetupBarDismissals();
  resetPendingRestarts();
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

describe('setup-changed bar live region', () => {
  it('is mounted before the bar shows, and its text changes when the bar appears and goes', async () => {
    const s = liveStatus(status({ waiting: false, changes: [] }));
    render(<SetupChangedBar agent={agent} variant="dock" />);
    const live = await screen.findByTestId('setup-changed-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveTextContent('');
    s.set(status());
    await waitFor(() => expect(screen.getByTestId('setup-changed-live')).toHaveTextContent('Setup changed since this session started: Rules was edited.'));
    // The same element: a live region announces changes, not insertions.
    expect(screen.getByTestId('setup-changed-live')).toBe(live);
    s.set(status({ waiting: false, changes: [] }));
    await waitFor(() => expect(screen.queryByTestId('setup-changed-bar')).toBeNull());
    expect(screen.getByTestId('setup-changed-live')).toBe(live);
    expect(live).toHaveTextContent('');
  });

  it('says plainly when the setup could not be written', async () => {
    liveStatus(status({ changes: ["Setup couldn't be written: disk full"], deliveryFailed: 'disk full' }));
    render(<SetupChangedBar agent={agent} variant="strip" />);
    expect(await screen.findByTestId('setup-changed-text')).toHaveTextContent("Setup couldn't be written: disk full");
    expect(screen.getByTestId('setup-changed-live')).toHaveTextContent("Setup couldn't be written: disk full");
  });
});

describe('Setup card live region', () => {
  beforeEach(() => {
    useAgentDetailsStore.setState({ open: true, settingsOpen: true, focus: null });
    vi.spyOn(m(), 'getSetup').mockResolvedValue({ ok: true, value: { version: 1, blocks: [], skills: [], mcps: [] } } as never);
    vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [] } as never);
    vi.spyOn(m(), 'listParts').mockResolvedValue({ ok: true, value: [] } as never);
  });

  it('stays mounted and fills in when changes start waiting', async () => {
    const s = liveStatus(status({ waiting: false, changes: [] }));
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    const live = await screen.findByTestId('details-setup-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveTextContent('');
    s.set(status());
    await waitFor(() => expect(screen.getByTestId('details-setup-live')).toHaveTextContent('Applies when it restarts or next wakes.'));
    expect(screen.getByTestId('details-setup-live')).toBe(live);
  });
});
