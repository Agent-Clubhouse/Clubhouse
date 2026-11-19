import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useAgentDetailsStore } from './detailsStore';
import { SettingsCard } from './SettingsCard';

const agent: Agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', name: 'Remote', kind: 'durable', status: 'sleeping', color: 'teal' };
const value = {
  version: 1, agentId: 'a1', readOnly: true,
  provider: 'Claude Code', model: 'host-model', runtime: 'chat', access: 'Full access',
  executionPolicy: 'on-request · workspace-write', autoSleep: 'Sleeps after 15 min', context: 'Host context',
  setup: { state: 'ok', managed: true, template: 'Remote template', instructions: '2 blocks', skills: ['Host skill'], mcps: ['Host MCP'], updatedBy: 'Host Dispatcher', updatedAt: '2026-11-18T12:00:00Z' },
};
const read = vi.fn();
function satellite(state = 'connected', snapshot: unknown = {}) {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', alias: 'Studio Mac', state, snapshot }] as never });
}
function show(target = agent) { return render(<SettingsCard agent={target} projectPath={undefined} provider="Controller CLI" />); }
beforeEach(() => {
  useAgentDetailsStore.setState({ settingsOpen: true });
  satellite();
  read.mockResolvedValue({ status: 'ok', value });
  Object.assign(window.clubhouse.annexClient, { agentSettings: read });
  vi.spyOn(window.clubhouse.agent, 'getDurableConfig');
  vi.spyOn(window.clubhouse.managed, 'getSetup');
  vi.spyOn(window.clubhouse.agentSettings, 'readInstructions');
});

describe('remote Settings read parity (#3733)', () => {
  it.each(['running', 'sleeping', 'error'] as const)('shows host managed settings read-only while %s', async (status) => {
    show({ ...agent, status });
    await waitFor(() => expect(screen.getByTestId('details-setting-template')).toHaveTextContent('Remote template'));
    expect(read).toHaveBeenCalledWith('sat', 'a1');
    expect(screen.getByTestId('details-setting-cli')).toHaveTextContent('Claude Code');
    expect(screen.getByTestId('details-setting-runs-in')).toHaveTextContent('Chat');
    expect(screen.getByTestId('details-setting-instructions')).toHaveTextContent('2 blocks');
    expect(screen.getByTestId('details-setting-mcp')).toHaveTextContent('Host MCP');
    expect(screen.getByTestId('details-setting-access')).toHaveTextContent('Full access');
    expect(screen.getByTestId('details-setting-execution-policy')).toHaveTextContent('workspace-write');
    expect(screen.getByTestId('details-setting-auto-sleep')).toHaveTextContent('15 min');
    expect(screen.getByText(/desired setup/i)).toBeInTheDocument();
    expect(screen.getByText('Change on Studio Mac')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText('All settings')).not.toBeInTheDocument();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
    expect(window.clubhouse.managed.getSetup).not.toHaveBeenCalled();
    expect(window.clubhouse.agentSettings.readInstructions).not.toHaveBeenCalled();
  });
  it('keeps the Settings card visible while reading and explains old-host support', async () => {
    let finish!: (x: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    show();
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading settings');
    await waitFor(() => expect(read).toHaveBeenCalled());
    await act(async () => { finish({ status: 'unavailable' }); });
    expect(screen.getByRole('status')).toHaveTextContent('doesn’t share these settings');
    expect(screen.queryByText('Existing level defaults')).not.toBeInTheDocument();
  });
  it.each(['forbidden', 'error', 'rate_limited'] as const)('explains a %s read without inventing defaults', async (status) => {
    read.mockResolvedValue({ status });
    show();
    await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('Loading'));
    expect(screen.queryByText('Existing level defaults')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    if (status === 'error') {
      read.mockResolvedValue({ status: 'ok', value });
      fireEvent.click(screen.getByText('Try again'));
      await waitFor(() => expect(screen.getByTestId('details-setting-template')).toHaveTextContent('Remote template'));
    }
  });
  it('drops old values immediately on target change and ignores an old pending response', async () => {
    let finish!: (x: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = show();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    read.mockResolvedValue({ status: 'ok', value: { ...value, agentId: 'a2', model: 'Second host model' } });
    view.rerender(<SettingsCard agent={{ ...agent, id: 'remote||sat||a2' }} projectPath={undefined} provider="Controller CLI" />);
    await waitFor(() => expect(screen.getByTestId('details-setting-model')).toHaveTextContent('Second host model'));
    await act(async () => { finish({ status: 'ok', value }); });
    expect(screen.getByTestId('details-setting-model')).toHaveTextContent('Second host model');
  });
  it('refreshes after wake and reconnect snapshots and hides cached values while offline', async () => {
    const sameSnapshot = useAnnexClientStore.getState().satellites[0].snapshot;
    const view = show();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('details-setting-template')).toBeInTheDocument());
    act(() => satellite('disconnected', sameSnapshot));
    expect(screen.queryByTestId('details-setting-template')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reconnect');
    act(() => satellite('connected', sameSnapshot));
    expect(screen.queryByTestId('details-setting-template')).not.toBeInTheDocument();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    view.rerender(<SettingsCard agent={{ ...agent, status: 'running', executionMode: 'chat' }} projectPath={undefined} provider="Controller CLI" />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    act(() => satellite('connected', { changed: true }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  });
  it('shows partial and unmanaged evidence explicitly for a remote Dispatcher', async () => {
    const dispatcher = { ...agent, projectId: 'remote||sat||__dispatcher__' };
    read.mockResolvedValue({ status: 'ok', value: { ...value, setup: { ...value.setup, state: 'error' } } });
    const view = show(dispatcher);
    await waitFor(() => expect(screen.getByText(/Couldn’t read the host’s configured/)).toBeInTheDocument());
    expect(screen.getByTestId('details-setting-model')).toHaveTextContent('host-model');
    read.mockResolvedValue({ status: 'ok', value: { ...value, setup: { ...value.setup, managed: false, template: null, instructions: 'Custom, 3 lines', skills: null, mcps: null } } });
    view.rerender(<SettingsCard agent={{ ...dispatcher, status: 'running' }} projectPath={undefined} provider="Controller CLI" />);
    await waitFor(() => expect(screen.getByTestId('details-setting-instructions')).toHaveTextContent('Custom, 3 lines'));
    expect(screen.getByTestId('details-setting-mcp')).toHaveTextContent('Not shared by host');
    expect(screen.queryByText('All settings')).not.toBeInTheDocument();
  });
  it('does not read a closed card or a quick agent through durable configuration routes', async () => {
    useAgentDetailsStore.setState({ settingsOpen: false });
    const view = show();
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    useAgentDetailsStore.setState({ settingsOpen: true });
    view.rerender(<SettingsCard agent={{ ...agent, kind: 'quick' }} projectPath={undefined} provider="Controller CLI" />);
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument();
  });

});
