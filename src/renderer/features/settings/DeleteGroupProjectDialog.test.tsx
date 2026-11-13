import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteGroupProjectDialog } from './DeleteGroupProjectDialog';

const impact = { token: 'token', members: ['Ada'], canvases: ['Home', 'Work'], actions: ['Build'], grants: ['Admin'], messages: 3, topics: 2, machines: ['Laptop'], incompleteWindows: false };

describe('DeleteGroupProjectDialog', () => {
  it('shows the full impact and requires an explicit confirmation', async () => {
    const confirmDelete = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<DeleteGroupProjectDialog name="Team" loadImpact={async () => impact} confirmDelete={confirmDelete} onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Home, Work')).toBeInTheDocument();
    expect(screen.getByText('3 messages in 2 topics')).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Laptop')).toBeInTheDocument();
    expect(confirmDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(confirmDelete).toHaveBeenCalledWith('token'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not permit confirmation after a failed impact check', async () => {
    const confirmDelete = vi.fn();
    render(<DeleteGroupProjectDialog name="Team" loadImpact={async () => { throw new Error('offline'); }} confirmDelete={confirmDelete} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    expect(confirmDelete).not.toHaveBeenCalled();
  });
});
