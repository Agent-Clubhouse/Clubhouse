import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAgentStore } from '../../stores/agentStore';
import { AgentConfigRecoveryNotice } from './AgentConfigRecoveryNotice';

it('shows uncertain storage and restores only after the person confirms (#3686)', async () => {
  window.clubhouse.agent.getBackupInfo = vi.fn().mockResolvedValue({ recoveryRequired: true, backupAgents: [{ id: 'a1' }] });
  window.clubhouse.agent.restoreFromBackup = vi.fn().mockResolvedValue({ restoredCount: 1 });
  const load = vi.fn().mockResolvedValue(undefined);
  useAgentStore.setState({ loadDurableAgents: load });
  render(<AgentConfigRecoveryNotice projectId="p1" projectPath="/proj" />);
  expect(await screen.findByTestId('agent-config-recovery')).toHaveTextContent('Can’t verify');
  expect(window.clubhouse.agent.restoreFromBackup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Restore saved backup' }));
  expect(await screen.findByText('Restore saved backup?')).toBeInTheDocument();
  expect(screen.getByText(/older Access, sandbox, approval and connection/)).toBeInTheDocument();
  expect(window.clubhouse.agent.restoreFromBackup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
  await waitFor(() => expect(load).toHaveBeenCalledWith('p1', '/proj'));
  expect(window.clubhouse.agent.restoreFromBackup).toHaveBeenCalledWith('/proj');
});

it('never reads or restores local storage for a remote project (#3686)', () => {
  window.clubhouse.agent.getBackupInfo = vi.fn();
  window.clubhouse.agent.restoreFromBackup = vi.fn();
  render(<AgentConfigRecoveryNotice projectId="remote||sat||p1" projectPath="/remote/proj" />);
  expect(window.clubhouse.agent.getBackupInfo).not.toHaveBeenCalled();
  expect(window.clubhouse.agent.restoreFromBackup).not.toHaveBeenCalled();
});
