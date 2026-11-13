import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { HandoffSecretSettingsSection } from './HandoffSecretSettingsSection';
beforeEach(() => {
  window.clubhouse.project.getHandoffSecretSettings = vi.fn().mockResolvedValue({ notSecretPaths: [], historyActionIds: [] });
  window.clubhouse.project.setHandoffSecretSettings = vi.fn().mockImplementation(async (_project, notSecretPaths) => ({ notSecretPaths, historyActionIds: ['handoff-secret:confirmation'] }));
});
it('requires an explicit person confirmation, displays history and can revoke paths', async () => {
  window.clubhouse.actions.history = vi.fn().mockResolvedValue([{ id: 'receipt', startedAt: 1, reason: 'Person confirmed non-secret paths.', steps: [{ detail: 'fixtures/token.txt' }] }]);
  render(<HandoffSecretSettingsSection projectId="project" />);
  const input = screen.getByLabelText('Confirmed non-secret paths');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'fixtures/token.txt' } });
  expect(window.clubhouse.project.setHandoffSecretSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm non-secret paths' }));
  await screen.findByRole('button', { name: 'View exception history' });
  expect(window.clubhouse.project.setHandoffSecretSettings).toHaveBeenCalledWith('project', ['fixtures/token.txt']);
  fireEvent.click(screen.getByRole('button', { name: 'View exception history' }));
  expect(await screen.findByText('fixtures/token.txt', { selector: 'pre' })).toBeInTheDocument();
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm non-secret paths' }));
  await waitFor(() => expect(window.clubhouse.project.setHandoffSecretSettings).toHaveBeenLastCalledWith('project', []));
});
it('reports persistence failure without showing an exception as saved', async () => {
  window.clubhouse.project.setHandoffSecretSettings = vi.fn().mockRejectedValue(new Error('raw secret path'));
  render(<HandoffSecretSettingsSection projectId="project" />);
  const input = screen.getByLabelText('Confirmed non-secret paths');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'fixture.txt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm non-secret paths' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Exceptions were not saved');
  expect(screen.queryByRole('button', { name: 'View exception history' })).not.toBeInTheDocument();
  expect(screen.queryByText('raw secret path')).not.toBeInTheDocument();
});
