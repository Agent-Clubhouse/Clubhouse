import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject } from '../../../shared/group-project-types';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { GroupProjectDeliverySection } from './GroupProjectDeliverySection';

const project = (metadata: Record<string, unknown>): GroupProject => ({
  id: 'gp1', name: 'Release', description: '', instructions: '', createdAt: '2026-11-13T00:00:00Z', metadata,
});

beforeEach(() => {
  useGroupProjectStore.setState({ projects: [project({})], operations: {}, loaded: true, loadError: null, loadOperations: vi.fn(async () => {}) });
});

describe('post notifications', () => {
  it.each([{}, { pollingEnabled: false }, { grants: { deliver: 'allow' } }])('shows the default or allowed effective state for %j', (metadata) => {
    useGroupProjectStore.setState({ projects: [project(metadata)] });
    render(<GroupProjectDeliverySection groupProjectId="gp1" />);
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Post notifications: On');
    expect(screen.queryByRole('button', { name: 'Use post notifications' })).not.toBeInTheDocument();
  });

  it('links Off to the existing permission without a second switch', async () => {
    useGroupProjectStore.setState({ projects: [project({ grants: { deliver: 'off' } })] });
    const open = vi.fn();
    render(<GroupProjectDeliverySection groupProjectId="gp1" onOpenPermissions={open} />);
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Post notifications: Off');
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Open Permissions' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('retains confirmed legacy state while busy and on failure, then permits retry', async () => {
    useGroupProjectStore.setState({ projects: [project({ pollingEnabled: true })] });
    let reject!: (error: Error) => void;
    const setPolling = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; }));
    useGroupProjectStore.setState({ setPolling });
    render(<GroupProjectDeliverySection groupProjectId="gp1" migration />);
    const action = screen.getByRole('button', { name: 'Use post notifications' });
    fireEvent.click(action);
    expect(action).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Legacy polling');
    await act(async () => reject(new Error('Host unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Host unavailable');
    expect(action).toBeEnabled();
    expect(setPolling).toHaveBeenCalledWith('gp1', false);
  });

  it('warns before a migration whose post notifications are Off', () => {
    useGroupProjectStore.setState({ projects: [project({ pollingEnabled: true, grants: { deliver: 'off' } })] });
    render(<GroupProjectDeliverySection groupProjectId="gp1" migration />);
    const action = screen.getByRole('button', { name: 'Use post notifications' });
    expect(action).toHaveAccessibleDescription(/notifications will remain Off/);
  });

  it('shows the host outcome while keeping the copy\'s confirmed mode until catch-up', async () => {
    const copy = { ...project({ pollingEnabled: true }), hostName: 'Studio', network: { role: 'replica' as const, state: 'cached' as const, waitingWrites: 1, refusals: [] } };
    useGroupProjectStore.setState({ projects: [copy], setPolling: vi.fn(async () => {}) });
    render(<GroupProjectDeliverySection groupProjectId="gp1" migration />);
    fireEvent.click(screen.getByRole('button', { name: 'Use post notifications' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use post notifications' })).toBeEnabled());
    const op = { id: 'op', groupProjectId: 'gp1', op: 'update', section: 'details' as const, author: { label: 'You' }, since: '2026-11-13T00:00:00Z' };
    act(() => useGroupProjectStore.setState({ operations: { gp1: { operations: [{ ...op, outcome: { status: 'queued', waitingFor: 'Studio', since: op.since } }], omittedQueued: 0 } } }));
    expect(screen.getByRole('list', { name: 'Changes to this group project' })).toHaveTextContent('Waiting for Studio');
    expect(screen.getByRole('button', { name: 'Use post notifications' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Legacy polling');
    act(() => useGroupProjectStore.setState({ operations: { gp1: { operations: [{ ...op, outcome: { status: 'refused', reason: 'Host declined' } }], omittedQueued: 0 } } }));
    expect(screen.getByRole('list', { name: 'Changes to this group project' })).toHaveTextContent('Refused: Host declined');
    expect(screen.getByRole('button', { name: 'Use post notifications' })).toBeEnabled();
    act(() => useGroupProjectStore.setState({ projects: [{ ...copy, metadata: { pollingEnabled: false } }], operations: { gp1: { operations: [{ ...op, outcome: { status: 'applied' } }], omittedQueued: 0 } } }));
    expect(screen.getByRole('list', { name: 'Changes to this group project' })).toHaveTextContent('Applied');
    expect(screen.getByRole('status', { name: 'Post notifications' })).toHaveTextContent('Post notifications: On');
  });
});
