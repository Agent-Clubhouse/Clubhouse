import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
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



});
