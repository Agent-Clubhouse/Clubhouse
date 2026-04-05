import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { SatelliteDashboard } from './SatelliteDashboard';
import type { SatelliteConnection } from '../../stores/annexClientStore';
import type { RemoteProject } from '../../stores/remoteProjectStore';

function makeSatellite(overrides: Partial<SatelliteConnection> = {}): SatelliteConnection {
  return {
    id: 'sat-1',
    alias: 'Office Mac',
    icon: '',
    color: 'emerald',
    fingerprint: 'sat-1',
    state: 'connected',
    host: '192.168.1.100',
    mainPort: 9090,
    pairingPort: 9091,
    snapshot: null,
    lastError: null,
    ...overrides,
  };
}

function makeRemoteProject(overrides: Partial<RemoteProject> = {}): RemoteProject {
  return {
    id: 'remote||sat-1||proj-1',
    name: 'remote-project',
    path: '__remote__',
    remote: true,
    satelliteId: 'sat-1',
    satelliteName: 'Office Mac',
    ...overrides,
  };
}

function resetStores() {
  useAnnexClientStore.setState({
    satellites: [],
    sendAgentKill: vi.fn(),
    sendAgentWake: vi.fn(),
  });
  useRemoteProjectStore.setState({
    satelliteProjects: {},
    remoteAgents: {},
    remoteAgentDetailedStatus: {},
    remoteAgentIcons: {},
    remoteProjectIcons: {},
  });
  useProjectStore.setState({
    projects: [],
    activeProjectId: null,
  });
}

describe('SatelliteDashboard', () => {
  beforeEach(resetStores);

  it('renders the satellite name and connected status', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByText('Office Mac')).toBeTruthy();
    expect(screen.getByText(/Connected/)).toBeTruthy();
  });

  it('shows empty state when satellite has no projects', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });
    useRemoteProjectStore.setState({ satelliteProjects: { 'sat-1': [] } });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByText('No projects on this satellite')).toBeTruthy();
  });

  it('renders project cards for satellite projects', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [
          makeRemoteProject({ id: 'remote||sat-1||p1', name: 'Alpha' }),
          makeRemoteProject({ id: 'remote||sat-1||p2', name: 'Beta' }),
        ],
      },
    });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('shows agent names in project card rows', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [makeRemoteProject({ id: 'remote||sat-1||p1', name: 'Alpha' })],
      },
      remoteAgents: {
        'remote||sat-1||agent-1': {
          id: 'remote||sat-1||agent-1',
          projectId: 'remote||sat-1||p1',
          name: 'builder',
          kind: 'durable',
          status: 'running',
          color: 'emerald',
        },
        'remote||sat-1||agent-2': {
          id: 'remote||sat-1||agent-2',
          projectId: 'remote||sat-1||p1',
          name: 'tester',
          kind: 'durable',
          status: 'sleeping',
          color: 'amber',
        },
      },
    });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByText('builder')).toBeTruthy();
    expect(screen.getByText('tester')).toBeTruthy();
  });

  it('renders stats overview with project and agent counts', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [
          makeRemoteProject({ id: 'remote||sat-1||p1', name: 'Alpha' }),
          makeRemoteProject({ id: 'remote||sat-1||p2', name: 'Beta' }),
        ],
      },
      remoteAgents: {
        'remote||sat-1||a1': {
          id: 'remote||sat-1||a1',
          projectId: 'remote||sat-1||p1',
          name: 'builder',
          kind: 'durable',
          status: 'running',
          color: 'emerald',
        },
      },
    });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    // Stats labels (matching local Dashboard style)
    expect(screen.getAllByText('Projects').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('Sleeping')).toBeTruthy();
    expect(screen.getByText('Attention')).toBeTruthy();
  });

  it('shows agent rows inside project cards', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [makeRemoteProject({ id: 'remote||sat-1||p1', name: 'Alpha' })],
      },
      remoteAgents: {
        'remote||sat-1||agent-1': {
          id: 'remote||sat-1||agent-1',
          projectId: 'remote||sat-1||p1',
          name: 'mega-fox',
          kind: 'durable',
          status: 'running',
          color: 'indigo',
        },
      },
    });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByText('mega-fox')).toBeTruthy();
    expect(screen.getByTestId('satellite-agent-row-remote||sat-1||agent-1')).toBeTruthy();
  });

  it('shows Remote badge in header', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByText('Remote')).toBeTruthy();
  });

  it('shows host address in header', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite({ host: '10.0.0.5' })] });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByText(/10\.0\.0\.5/)).toBeTruthy();
  });

  it('clicking agent row navigates to that agent', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [makeRemoteProject({ id: 'remote||sat-1||p1', name: 'Alpha' })],
      },
      remoteAgents: {
        'remote||sat-1||agent-1': {
          id: 'remote||sat-1||agent-1',
          projectId: 'remote||sat-1||p1',
          name: 'mega-fox',
          kind: 'durable',
          status: 'running',
          color: 'indigo',
        },
      },
    });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    const agentRow = screen.getByTestId('satellite-agent-row-remote||sat-1||agent-1');
    fireEvent.click(agentRow);

    expect(useProjectStore.getState().activeProjectId).toBe('remote||sat-1||p1');
  });

  it('shows wake button for sleeping durable agents', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [makeRemoteProject({ id: 'remote||sat-1||p1', name: 'Alpha' })],
      },
      remoteAgents: {
        'remote||sat-1||agent-1': {
          id: 'remote||sat-1||agent-1',
          projectId: 'remote||sat-1||p1',
          name: 'sleeper',
          kind: 'durable',
          status: 'sleeping',
          color: 'emerald',
        },
      },
    });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByTestId('satellite-action-wake')).toBeTruthy();
  });

  it('shows stop button for running agents', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [makeRemoteProject({ id: 'remote||sat-1||p1', name: 'Alpha' })],
      },
      remoteAgents: {
        'remote||sat-1||agent-1': {
          id: 'remote||sat-1||agent-1',
          projectId: 'remote||sat-1||p1',
          name: 'runner',
          kind: 'durable',
          status: 'running',
          color: 'emerald',
        },
      },
    });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByTestId('satellite-action-stop')).toBeTruthy();
  });

  it('falls back to "Remote" name when satellite not found in store', () => {
    useAnnexClientStore.setState({ satellites: [] });

    render(<SatelliteDashboard activeHostId="sat-unknown" />);

    // "Remote" appears as both the header title (fallback) and the badge
    expect(screen.getAllByText('Remote').length).toBeGreaterThanOrEqual(1);
  });

  it('has the satellite-dashboard test id', () => {
    useAnnexClientStore.setState({ satellites: [makeSatellite()] });

    render(<SatelliteDashboard activeHostId="sat-1" />);

    expect(screen.getByTestId('satellite-dashboard')).toBeTruthy();
  });
});
