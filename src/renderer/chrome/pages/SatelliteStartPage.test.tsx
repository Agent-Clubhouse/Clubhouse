import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SatelliteStartPage, projectCounts } from './SatelliteStartPage';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { useChromeStore } from '../chromeStore';
import type { Agent } from '../../../shared/types';

const sat = { id: 's1', alias: 'Studio Mac', state: 'connected', host: '192.168.1.24' };
const agent = (id: string, projectId: string, over: Partial<Agent> = {}) =>
  ({ id, projectId, name: id, kind: 'durable', status: 'running', color: 'blue', ...over }) as Agent;

beforeEach(() => {
  useAnnexClientStore.setState({ satellites: [sat] as never });
  useRemoteProjectStore.setState({
    satelliteProjects: { s1: [{ id: 'r:p1', name: 'Clubhouse-Go', path: '~/go' }, { id: 'r:p2', name: 'Goobers', path: '~/gb' }] } as never,
    remoteAgents: { 'r:a1': agent('r:a1', 'r:p1'), 'r:a2': agent('r:a2', 'r:p1'), 'r:a3': agent('r:a3', 'r:p2', { status: 'sleeping' }) },
    remoteAgentDetailedStatus: { 'r:a1': { state: 'needs_permission', message: 'x', timestamp: 1 }, 'r:a2': { state: 'working', message: 'y', timestamp: 1 } } as never,
    remoteProjectIcons: {},
  });
  useUIStore.setState({ activeHostId: 's1', explorerTab: 'agents' });
  useProjectStore.setState({ activeProjectId: null });
});

describe('SatelliteStartPage', () => {
  it('names the satellite and its connection in one line, with projects as rows', () => {
    render(<SatelliteStartPage activeHostId="s1" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Studio Mac');
    expect(screen.getByText('Connected · 192.168.1.24 · 2 projects, 3 agents')).toBeTruthy();
    expect(screen.getByTestId('satellite-project-r:p1').textContent).toContain('1 needs you, 1 working');
    expect(screen.getByTestId('satellite-project-r:p2').textContent).toContain('1 agent');
    expect(screen.getByTestId('satellite-start-page').textContent).not.toMatch(/Remote|Attention/);
  });

  it("opens a project's start page", () => {
    render(<SatelliteStartPage activeHostId="s1" />);
    fireEvent.click(screen.getByTestId('satellite-project-r:p2'));
    expect(useProjectStore.getState().activeProjectId).toBe('r:p2');
    expect(useChromeStore.getState().projectScopeId).toBe('r:p2');
  });

  it('says what to do when nothing is open there', () => {
    useRemoteProjectStore.setState({ satelliteProjects: {}, remoteAgents: {} });
    render(<SatelliteStartPage activeHostId="s1" />);
    expect(screen.getByText('Connected · 192.168.1.24 · no projects open')).toBeTruthy();
    fireEvent.click(screen.getByText('Switch to Local'));
    expect(useUIStore.getState().activeHostId).toBeNull();
  });

  it('counts agents in plain text', () => {
    expect(projectCounts([], () => 'idle')).toBe('No agents');
    expect(projectCounts([agent('a', 'p'), agent('b', 'p')], () => 'idle')).toBe('2 agents');
  });
});
