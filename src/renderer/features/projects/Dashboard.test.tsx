import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { useQuickAgentStore } from '../../stores/quickAgentStore';
import { Dashboard } from './Dashboard';
import type { Agent, Project, CompletedQuickAgent, AgentDetailedStatus } from '../../../shared/types';

/* ─── Helpers ─── */

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'test-project',
    path: '/home/user/test-project',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    projectId: 'proj-1',
    name: 'brave-falcon',
    kind: 'durable',
    status: 'sleeping',
    color: 'emerald',
    ...overrides,
  };
}

function makeCompletedAgent(overrides: Partial<CompletedQuickAgent> = {}): CompletedQuickAgent {
  return {
    id: 'completed-1',
    projectId: 'proj-1',
    name: 'quick-fox',
    mission: 'Fix the login bug',
    summary: 'Fixed the issue by updating the auth handler',
    filesModified: ['src/auth.ts'],
    exitCode: 0,
    completedAt: Date.now() - 60_000, // 1 minute ago
    ...overrides,
  };
}

function resetStores() {
  useProjectStore.setState({
    projects: [],
    activeProjectId: null,
    projectIcons: {},
  });
  useAgentStore.setState({
    agents: {},
    activeAgentId: null,
    agentDetailedStatus: {},
  });
  useUIStore.setState({
    explorerTab: 'agents',
    settingsSubPage: 'display',
    settingsContext: 'app',
  });
  useQuickAgentStore.setState({
    completedAgents: {},
    selectedCompletedId: null,
  });
}

/* ─── Tests ─── */

describe('Dashboard', () => {
  beforeEach(resetStores);

  describe('empty state', () => {
    it('renders empty state when no projects exist', () => {
      render(<Dashboard />);
      expect(screen.getByText('Home')).toBeInTheDocument();
      expect(screen.getByText('No projects yet')).toBeInTheDocument();
      expect(screen.getByText('Add Project')).toBeInTheDocument();
    });

    it('calls pickAndAddProject when Add Project button is clicked', () => {
      const pickAndAddProject = vi.fn();
      useProjectStore.setState({ pickAndAddProject });

      render(<Dashboard />);
      fireEvent.click(screen.getByText('Add Project'));
      expect(pickAndAddProject).toHaveBeenCalledOnce();
    });
  });

  describe('with projects', () => {
    const project1 = makeProject({ id: 'proj-1', name: 'my-app', path: '/home/user/my-app' });
    const project2 = makeProject({ id: 'proj-2', name: 'backend', path: '/home/user/backend' });

    beforeEach(() => {
      useProjectStore.setState({
        projects: [project1, project2],
        pickAndAddProject: vi.fn(),
      });
    });

    it('renders the Projects section header', () => {
      render(<Dashboard />);
      const headers = screen.getAllByText('Projects');
      // Should appear as both a stat card label and a section header
      expect(headers.length).toBeGreaterThanOrEqual(2);
    });

    it('renders project cards for each project', () => {
      render(<Dashboard />);
      expect(screen.getByText('my-app')).toBeInTheDocument();
      expect(screen.getByText('backend')).toBeInTheDocument();
    });

    it('renders project paths', () => {
      render(<Dashboard />);
      expect(screen.getByText('/home/user/my-app')).toBeInTheDocument();
      expect(screen.getByText('/home/user/backend')).toBeInTheDocument();
    });

    it('renders Add button in projects header', () => {
      render(<Dashboard />);
      expect(screen.getByText('Add')).toBeInTheDocument();
    });

    it('renders "No agents yet" for projects without agents', () => {
      render(<Dashboard />);
      const noAgentTexts = screen.getAllByText('No agents yet');
      expect(noAgentTexts).toHaveLength(2);
    });
  });

  describe('stats overview', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: [makeProject()],
        pickAndAddProject: vi.fn(),
      });
    });

    it('renders stat cards', () => {
      render(<Dashboard />);
      expect(screen.getAllByText('Projects').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Working')).toBeInTheDocument();
      expect(screen.getByText('Attention')).toBeInTheDocument();
      expect(screen.getByText('Done today')).toBeInTheDocument();
    });

    it('shows correct project count', () => {
      useProjectStore.setState({
        projects: [makeProject(), makeProject({ id: 'proj-2', name: 'b' })],
        pickAndAddProject: vi.fn(),
      });
      render(<Dashboard />);
      // Should show "2" for Projects stat
      const stats = screen.getAllByText('2');
      expect(stats.length).toBeGreaterThanOrEqual(1);
    });

    it('counts working agents', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', status: 'running' }),
          'a2': makeAgent({ id: 'a2', status: 'running' }),
        },
        agentDetailedStatus: {
          'a1': { state: 'working', message: 'Editing file', timestamp: Date.now() } as AgentDetailedStatus,
          'a2': { state: 'working', message: 'Reading file', timestamp: Date.now() } as AgentDetailedStatus,
        },
      });
      render(<Dashboard />);
      // "2" should appear for Working count
      const twos = screen.getAllByText('2');
      expect(twos.length).toBeGreaterThanOrEqual(1);
    });

    it('counts agents needing attention', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', status: 'running' }),
          'a2': makeAgent({ id: 'a2', status: 'error' }),
        },
        agentDetailedStatus: {
          'a1': { state: 'needs_permission', message: 'Needs permission', timestamp: Date.now() } as AgentDetailedStatus,
        },
      });
      render(<Dashboard />);
      // "2" attention agents (one needs_permission + one error)
      const twos = screen.getAllByText('2');
      expect(twos.length).toBeGreaterThanOrEqual(1);
    });

    it('counts completed agents from today', () => {
      useQuickAgentStore.setState({
        completedAgents: {
          'proj-1': [
            makeCompletedAgent({ completedAt: Date.now() - 1000 }),
            makeCompletedAgent({ id: 'c2', completedAt: Date.now() - 5000 }),
          ],
        },
      });
      render(<Dashboard />);
      // "2" for done today
      const twos = screen.getAllByText('2');
      expect(twos.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('needs attention section', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: [makeProject()],
        pickAndAddProject: vi.fn(),
      });
    });

    it('does not render when no agents need attention', () => {
      useAgentStore.setState({
        agents: { 'a1': makeAgent({ status: 'sleeping' }) },
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      expect(screen.queryByText(/need.*attention/i)).toBeNull();
    });

    it('renders needs attention for agents with permission requests', () => {
      useAgentStore.setState({
        agents: { 'a1': makeAgent({ id: 'a1', status: 'running', name: 'perm-falcon' }) },
        agentDetailedStatus: {
          'a1': { state: 'needs_permission', message: 'Needs permission', timestamp: Date.now() } as AgentDetailedStatus,
        },
      });
      render(<Dashboard />);
      expect(screen.getByText(/1 agent needs attention/)).toBeInTheDocument();
      // Agent name appears in both attention box and project card
      expect(screen.getAllByText('perm-falcon').length).toBeGreaterThanOrEqual(1);
      // "Needs permission" appears in both attention box and agent row
      expect(screen.getAllByText('Needs permission').length).toBeGreaterThanOrEqual(1);
    });

    it('renders needs attention for error agents', () => {
      useAgentStore.setState({
        agents: { 'a1': makeAgent({ id: 'a1', status: 'error', name: 'error-otter' }) },
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      expect(screen.getByText(/1 agent needs attention/)).toBeInTheDocument();
      // "Error" may appear as both status label and reason; confirm at least one exists
      expect(screen.getAllByText('Error').length).toBeGreaterThanOrEqual(1);
    });

    it('renders needs attention for tool error agents', () => {
      useAgentStore.setState({
        agents: { 'a1': makeAgent({ id: 'a1', status: 'running', name: 'tool-agent' }) },
        agentDetailedStatus: {
          'a1': { state: 'tool_error', message: 'Tool failed', timestamp: Date.now() } as AgentDetailedStatus,
        },
      });
      render(<Dashboard />);
      expect(screen.getAllByText('Tool failed').length).toBeGreaterThanOrEqual(1);
    });

    it('pluralizes correctly for multiple agents', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', status: 'error', name: 'agent-1' }),
          'a2': makeAgent({ id: 'a2', status: 'error', name: 'agent-2' }),
        },
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      expect(screen.getByText(/2 agents need attention/)).toBeInTheDocument();
    });

    it('navigates to agent on click', () => {
      const setActiveProject = vi.fn();
      const setActiveAgent = vi.fn();
      const setExplorerTab = vi.fn();

      useProjectStore.setState({ setActiveProject, projects: [makeProject()], pickAndAddProject: vi.fn() });
      useAgentStore.setState({
        agents: { 'a1': makeAgent({ id: 'a1', status: 'error', name: 'nav-test-agent' }) },
        agentDetailedStatus: {},
        setActiveAgent,
      });
      useUIStore.setState({ setExplorerTab });

      render(<Dashboard />);
      // Agent name appears in both attention box and project card; click the first one
      const agentButtons = screen.getAllByText('nav-test-agent');
      fireEvent.click(agentButtons[0]);

      expect(setActiveProject).toHaveBeenCalledWith('proj-1');
      expect(setActiveAgent).toHaveBeenCalledWith('a1', 'proj-1');
      expect(setExplorerTab).toHaveBeenCalledWith('agents', 'proj-1');
    });
  });

  describe('project card navigation', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: [makeProject()],
        setActiveProject: vi.fn(),
        pickAndAddProject: vi.fn(),
      });
      useAgentStore.setState({
        agents: { 'a1': makeAgent() },
        agentDetailedStatus: {},
      });
    });

    it('navigates to project on project name click', () => {
      const setActiveProject = vi.fn();
      useProjectStore.setState({ setActiveProject });

      render(<Dashboard />);
      fireEvent.click(screen.getByText('test-project'));

      expect(setActiveProject).toHaveBeenCalledWith('proj-1');
    });

    it('settings button opens project settings (not app settings)', () => {
      const setActiveProject = vi.fn();
      const setExplorerTab = vi.fn();
      const setSettingsContext = vi.fn();

      useProjectStore.setState({ setActiveProject });
      useUIStore.setState({ setExplorerTab, setSettingsContext });

      render(<Dashboard />);
      fireEvent.click(screen.getByTitle('Project Settings'));

      expect(setActiveProject).toHaveBeenCalledWith('proj-1');
      expect(setExplorerTab).toHaveBeenCalledWith('settings');
      expect(setSettingsContext).toHaveBeenCalledWith('proj-1');
    });

    it('hub button opens hub plugin tab (not invalid "hub" tab)', () => {
      const setActiveProject = vi.fn();
      const setExplorerTab = vi.fn();

      useProjectStore.setState({ setActiveProject });
      useUIStore.setState({ setExplorerTab });

      render(<Dashboard />);
      fireEvent.click(screen.getByTitle('Open Hub'));

      expect(setActiveProject).toHaveBeenCalledWith('proj-1');
      expect(setExplorerTab).toHaveBeenCalledWith('plugin:hub', 'proj-1');
    });
  });

  describe('agent avatar profile pics', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: [makeProject()],
        pickAndAddProject: vi.fn(),
      });
    });

    it('renders profile image when agent has icon and iconDataUrl', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', name: 'pic-agent', icon: 'avatar.png' }),
        },
        agentIcons: { 'a1': 'data:image/png;base64,abc123' },
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      const img = screen.getByAltText('pic-agent');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', 'data:image/png;base64,abc123');
    });

    it('renders initials when agent has no icon set', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', name: 'brave-falcon' }),
        },
        agentIcons: {},
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      expect(screen.queryByAltText('brave-falcon')).toBeNull();
      expect(screen.getByText('BF')).toBeInTheDocument();
    });

    it('renders initials when agent has icon flag but no loaded data URL', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', name: 'brave-falcon', icon: 'avatar.png' }),
        },
        agentIcons: {},
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      expect(screen.queryByAltText('brave-falcon')).toBeNull();
      expect(screen.getByText('BF')).toBeInTheDocument();
    });

    it('renders profile image in needs-attention section', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', name: 'alert-agent', status: 'error', icon: 'avatar.png' }),
        },
        agentIcons: { 'a1': 'data:image/png;base64,alertpic' },
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      const imgs = screen.getAllByAltText('alert-agent');
      // Should appear in both needs-attention box and project card agent row
      expect(imgs.length).toBeGreaterThanOrEqual(2);
      imgs.forEach((img) => {
        expect(img).toHaveAttribute('src', 'data:image/png;base64,alertpic');
      });
    });
  });

  describe('agent display', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: [makeProject()],
        pickAndAddProject: vi.fn(),
      });
    });

    it('shows durable agents in project card', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', name: 'brave-falcon', kind: 'durable', status: 'sleeping' }),
        },
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      expect(screen.getByText('brave-falcon')).toBeInTheDocument();
      expect(screen.getByText('Sleeping')).toBeInTheDocument();
    });

    it('shows agent branch when available', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', name: 'brave-falcon', branch: 'feat/login' }),
        },
        agentDetailedStatus: {},
      });
      render(<Dashboard />);
      expect(screen.getByText('feat/login')).toBeInTheDocument();
    });

    it('shows detailed status for running agents', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', name: 'brave-falcon', status: 'running' }),
        },
        agentDetailedStatus: {
          'a1': { state: 'working', message: 'Editing src/main.ts', timestamp: Date.now() } as AgentDetailedStatus,
        },
      });
      render(<Dashboard />);
      expect(screen.getByText('Editing src/main.ts')).toBeInTheDocument();
    });

    it('shows quick sessions count when more than 3', () => {
      const agents: Record<string, Agent> = {};
      for (let i = 1; i <= 5; i++) {
        agents[`q${i}`] = makeAgent({ id: `q${i}`, name: `quick-${i}`, kind: 'quick', status: 'running' });
      }
      useAgentStore.setState({ agents, agentDetailedStatus: {} });
      render(<Dashboard />);
      expect(screen.getByText('5 quick sessions')).toBeInTheDocument();
    });

    it('shows status pills on project card', () => {
      useAgentStore.setState({
        agents: {
          'a1': makeAgent({ id: 'a1', status: 'running' }),
          'a2': makeAgent({ id: 'a2', status: 'sleeping' }),
        },
        agentDetailedStatus: {
          'a1': { state: 'working', message: 'Working', timestamp: Date.now() } as AgentDetailedStatus,
        },
      });
      render(<Dashboard />);
      // Should have status dots; exact rendering depends on implementation
      const pills = screen.getAllByText('1');
      expect(pills.length).toBeGreaterThanOrEqual(2); // 1 working, 1 sleeping
    });
  });

  describe('recent activity', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: [makeProject()],
        pickAndAddProject: vi.fn(),
        setActiveProject: vi.fn(),
      });
    });

    it('does not render when no completed agents exist', () => {
      render(<Dashboard />);
      expect(screen.queryByText('Recent Activity')).toBeNull();
    });

    it('renders recent activity section with completed agents', () => {
      useQuickAgentStore.setState({
        completedAgents: {
          'proj-1': [makeCompletedAgent()],
        },
      });
      render(<Dashboard />);
      expect(screen.getByText('Recent Activity')).toBeInTheDocument();
      expect(screen.getByText('quick-fox')).toBeInTheDocument();
      expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
    });

    it('shows project name in activity items', () => {
      useQuickAgentStore.setState({
        completedAgents: {
          'proj-1': [makeCompletedAgent()],
        },
      });
      render(<Dashboard />);
      // "test-project" appears in both the project card and activity item
      const names = screen.getAllByText('test-project');
      expect(names.length).toBeGreaterThanOrEqual(2); // card + activity
    });

    it('shows cost when available', () => {
      useQuickAgentStore.setState({
        completedAgents: {
          'proj-1': [makeCompletedAgent({ costUsd: 0.15 })],
        },
      });
      render(<Dashboard />);
      expect(screen.getByText('$0.15')).toBeInTheDocument();
    });

    it('limits to 8 recent items', () => {
      const records: CompletedQuickAgent[] = [];
      for (let i = 0; i < 12; i++) {
        records.push(makeCompletedAgent({
          id: `c${i}`,
          name: `agent-${i}`,
          mission: `Task ${i}`,
          completedAt: Date.now() - i * 60_000,
        }));
      }
      useQuickAgentStore.setState({
        completedAgents: { 'proj-1': records },
      });
      render(<Dashboard />);
      // Should show first 8 (most recent)
      expect(screen.getByText('agent-0')).toBeInTheDocument();
      expect(screen.getByText('agent-7')).toBeInTheDocument();
      expect(screen.queryByText('agent-8')).toBeNull();
    });

    it('sorts activity by most recent first across projects', () => {
      const proj2 = makeProject({ id: 'proj-2', name: 'other-project' });
      useProjectStore.setState({
        projects: [makeProject(), proj2],
        pickAndAddProject: vi.fn(),
        setActiveProject: vi.fn(),
      });
      useQuickAgentStore.setState({
        completedAgents: {
          'proj-1': [makeCompletedAgent({ id: 'c1', name: 'older', completedAt: Date.now() - 120_000 })],
          'proj-2': [makeCompletedAgent({ id: 'c2', name: 'newer', projectId: 'proj-2', completedAt: Date.now() - 30_000 })],
        },
      });
      render(<Dashboard />);
      const items = screen.getAllByRole('button').filter((btn) =>
        btn.textContent?.includes('older') || btn.textContent?.includes('newer')
      );
      // "newer" should appear before "older" in the DOM
      const newerIndex = items.findIndex((el) => el.textContent?.includes('newer'));
      const olderIndex = items.findIndex((el) => el.textContent?.includes('older'));
      expect(newerIndex).toBeLessThan(olderIndex);
    });

    it('navigates to project on activity item click', () => {
      const setActiveProject = vi.fn();
      useProjectStore.setState({ setActiveProject });
      useQuickAgentStore.setState({
        completedAgents: {
          'proj-1': [makeCompletedAgent()],
        },
      });
      render(<Dashboard />);
      fireEvent.click(screen.getByText('quick-fox'));
      expect(setActiveProject).toHaveBeenCalledWith('proj-1');
    });
  });

  describe('project displayName', () => {
    it('renders displayName when provided', () => {
      useProjectStore.setState({
        projects: [makeProject({ displayName: 'My Cool App' })],
        pickAndAddProject: vi.fn(),
      });
      render(<Dashboard />);
      expect(screen.getByText('My Cool App')).toBeInTheDocument();
    });

    it('falls back to name when displayName is not set', () => {
      useProjectStore.setState({
        projects: [makeProject({ name: 'fallback-name' })],
        pickAndAddProject: vi.fn(),
      });
      render(<Dashboard />);
      expect(screen.getByText('fallback-name')).toBeInTheDocument();
    });
  });
});
