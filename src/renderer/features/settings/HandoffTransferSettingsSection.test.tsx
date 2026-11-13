import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { HANDOFF_TRANSFER_DEFAULTS } from '../../../shared/handoff-manifest';
import { HandoffTransferSettingsSection } from './HandoffTransferSettingsSection';
beforeEach(() => {
  window.clubhouse.project.getHandoffTransferBounds = vi.fn().mockResolvedValue(HANDOFF_TRANSFER_DEFAULTS);
  window.clubhouse.project.setHandoffTransferBounds = vi.fn().mockImplementation(async (_id, bounds) => bounds);
});
it('shows MiB values and saves changed limits only after the person chooses Save', async () => {
  render(<HandoffTransferSettingsSection projectId="project" />);
  const total = screen.getByLabelText('Total limit (MiB)');
  await waitFor(() => expect(total).toHaveValue(1024));
  expect(screen.getByLabelText('Per-file limit (MiB)')).toHaveValue(256);
  fireEvent.change(total, { target: { value: '2048' } });
  expect(window.clubhouse.project.setHandoffTransferBounds).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save transfer limits' }));
  await waitFor(() => expect(window.clubhouse.project.setHandoffTransferBounds).toHaveBeenCalledWith('project', { ...HANDOFF_TRANSFER_DEFAULTS, totalBytes: 2 * 1024 ** 3 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save transfer limits' })).toBeDisabled());
});
it('keeps an unsuccessful save visibly pending without reflecting private errors', async () => {
  window.clubhouse.project.setHandoffTransferBounds = vi.fn().mockRejectedValue(new Error('private disk details'));
  render(<HandoffTransferSettingsSection projectId="project" />);
  const total = screen.getByLabelText('Total limit (MiB)');
  await waitFor(() => expect(total).toBeEnabled());
  fireEvent.change(total, { target: { value: '2048' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save transfer limits' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Limits were not saved');
  expect(screen.getByRole('button', { name: 'Save transfer limits' })).toBeEnabled();
  expect(screen.queryByText('private disk details')).not.toBeInTheDocument();
});
