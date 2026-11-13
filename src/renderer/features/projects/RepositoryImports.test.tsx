import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportPlan, ImportStatus, ImportedAgentReview } from '../../../shared/project-import';
import { RepositoryImports } from './RepositoryImports';
import { GrantRequestList } from '../agents/GrantRequestList';
import { useGrantRequestStore } from '../../stores/grantRequestStore';
import { useProjectStore } from '../../stores/projectStore';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { openDispatcher } from '../dispatcher/dispatcherNav';

vi.mock('../dispatcher/dispatcherNav', () => ({ openDispatcher: vi.fn() }));

const plan: ImportPlan = {
  id: 'plan', agentId: 'dispatcher', url: 'https://github.com/user/chosen-repo.git',
  destination: '/projects/new-checkout', parent: '/projects', parentIdentity: '1:42',
  branch: 'release', defaultBranch: 'trunk', commit: 'a'.repeat(40), headCommit: 'b'.repeat(40),
  createdAt: 0, expiresAt: 600_000,
  effects: ['Create only the exact new destination.', 'Register the project and add .gitignore rules.', 'Do not create or start an agent.'],
};
const receipt = (updates: Partial<ImportStatus> = {}): ImportStatus => ({
  id: 'owned-import', plan, phase: 'fetching', progress: 12, updatedAt: 1,
  cloneCompleted: false, agentCreated: false, agentStarted: false,
  recovery: 'Read status or cancel this import. Files are preserved.', ...updates,
});
const request = (review: { importReview?: ImportPlan; agentReview?: ImportedAgentReview }) => ({
  requestId: 'exact-review', kind: 'call' as const, agentId: 'dispatcher', agentName: 'Dispatcher',
  projectPath: '/dispatcher', actions: ['project.add' as const], where: 'projects', toolName: 'import_repository',
  createdAt: new Date(0).toISOString(), expiresAt: new Date(600_000).toISOString(), ...review,
});

beforeEach(() => {
  useGrantRequestStore.setState({ requests: {}, reviewing: null });
  useDispatcherStore.setState({ project: { id: 'dispatcher', name: 'Dispatcher', path: '/dispatcher' } });
  useProjectStore.setState({ activeProjectId: null, projects: [], gitStatus: {} });
  window.clubhouse.project.listImports = vi.fn(async () => ({ ok: true, value: [] }));
  window.clubhouse.project.cancelImport = vi.fn(async () => ({ ok: true, value: { status: 'cancellation_requested', receipt: receipt() } }));
  window.clubhouse.agent.answerGrantRequest = vi.fn(async () => ({ ok: true }));
  window.clubhouse.agent.spawnAgent = vi.fn();
  window.clubhouse.agent.createDurable = vi.fn();
});
afterEach(() => { vi.useRealTimers(); });

describe('repository import user review and progress (#2808)', () => {
  it('shows the server plan in Needs you and sends only a user answer, not import/creation/start authority', async () => {
    useGrantRequestStore.getState().add(request({ importReview: plan }));
    render(<GrantRequestList agentId="dispatcher" agentName="Dispatcher" />);
    expect(screen.getByTestId('import-review')).toHaveTextContent('NEW directory');
    expect(screen.getByText(`Repository: ${plan.url}`)).toBeInTheDocument();
    expect(screen.getByText(`Destination: ${plan.destination}`)).toBeInTheDocument();
    expect(screen.getByText('Existing parent: /projects (identity 1:42)')).toBeInTheDocument();
    expect(screen.getByText('Default branch: trunk')).toBeInTheDocument();
    expect(screen.getByText('Selected branch: release')).toBeInTheDocument();
    expect(screen.getByText(`Selected commit: ${plan.commit}`)).toBeInTheDocument();
    expect(screen.getByText(`Default tip: ${plan.headCommit}`)).toBeInTheDocument();
    expect(screen.getByText('Do not create or start an agent.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('grant-request-allow'));
    await waitFor(() => expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledWith('exact-review', true));
    expect(window.clubhouse.agent.createDurable).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.spawnAgent).not.toHaveBeenCalled();
  });

  it('shows effective inherited template/CLI/model/access/Free Agent/orchestration/connection choices and keeps create-only separate from start', async () => {
    const review: ImportedAgentReview = {
      importId: 'owned-import', projectId: 'real-project', projectPath: plan.destination, name: 'owner',
      templateId: 'chosen-template', templateName: 'Chosen template', connectToDispatcher: true,
      settings: { orchestrator: 'copilot-cli', model: 'gpt-6.1-sol', effort: 'high', access: 'auto', freeAgentMode: true, orchestration: { orchestrate: true, crossProjectHelpers: false } },
      effects: ['Create one managed agent, asleep.', 'No prompt or repository setup is run.'],
    };
    useGrantRequestStore.getState().add(request({ agentReview: review }));
    render(<GrantRequestList agentId="dispatcher" agentName="Dispatcher" />);
    expect(screen.getByTestId('import-agent-review')).toHaveTextContent('Create owner, asleep');
    expect(screen.getByText('Template: Chosen template')).toBeInTheDocument();
    expect(screen.getByText('CLI: copilot-cli; model: gpt-6.1-sol; effort: high')).toBeInTheDocument();
    expect(screen.getByText('Access: auto; Free Agent Mode: On')).toBeInTheDocument();
    expect(screen.getByText('Orchestration: On; cross-project helpers: Off')).toBeInTheDocument();
    expect(screen.getByText(/separately authorized bootstrap/)).toBeInTheDocument();
    expect(screen.getByText(/Creation is not start approval/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('grant-request-decline'));
    await waitFor(() => expect(window.clubhouse.agent.answerGrantRequest).toHaveBeenCalledWith('exact-review', false));
    expect(window.clubhouse.agent.spawnAgent).not.toHaveBeenCalled();
  });

  it('updates bounded progress responsively and cancellation names only the exact owned receipt/path', async () => {
    vi.useFakeTimers();
    vi.mocked(window.clubhouse.project.listImports)
      .mockResolvedValueOnce({ ok: true, value: [receipt()] })
      .mockResolvedValue({ ok: true, value: [receipt({ progress: 75 })] });
    render(<RepositoryImports />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('repository-imports-open'));
    expect(screen.getByRole('status')).toHaveTextContent('Import: fetching (12%)');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole('status')).toHaveTextContent('Import: fetching (75%)');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this import' }));
    await act(async () => {});
    expect(window.clubhouse.project.cancelImport).toHaveBeenCalledWith('owned-import', '/projects/new-checkout');
    expect(window.clubhouse.agent.spawnAgent).not.toHaveBeenCalled();
  });

  it('retains partial success, failed operation/recovery and separate agent outcome; opening/choosing never starts an agent', async () => {
    vi.mocked(window.clubhouse.project.listImports).mockResolvedValue({ ok: true, value: [receipt({
      phase: 'partial', projectId: 'real-project', failedAt: 'registering', reason: 'gitignore_failed',
      message: 'Registration finished; ignore rules did not.', recovery: 'Reuse real-project; do not clone again.',
    })] });
    render(<RepositoryImports />);
    fireEvent.click(await screen.findByTestId('repository-imports-open'));
    expect(screen.getByRole('status')).toHaveTextContent('Import: partial');
    expect(screen.getByText('Failed operation: registering')).toBeInTheDocument();
    expect(screen.getByText('Reuse real-project; do not clone again.')).toBeInTheDocument();
    expect(screen.getByText(/Agent creation: not requested/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose agent with Dispatcher' }));
    expect(openDispatcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('repository-imports-open'));
    fireEvent.click(screen.getByRole('button', { name: 'Open existing project' }));
    expect(useProjectStore.getState().activeProjectId).toBe('real-project');
    expect(window.clubhouse.agent.createDurable).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.spawnAgent).not.toHaveBeenCalled();
  });

  it('shows sanitized read/cancel failures rather than success-shaped fallbacks', async () => {
    vi.mocked(window.clubhouse.project.listImports).mockResolvedValue({ ok: true, value: [receipt()] });
    vi.mocked(window.clubhouse.project.cancelImport).mockResolvedValue({ ok: false, reason: 'plan_mismatch', message: 'Cancellation must name the exact owned destination.' });
    render(<RepositoryImports />);
    fireEvent.click(await screen.findByTestId('repository-imports-open'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation must name the exact owned destination.');
    expect(screen.getByRole('status')).toHaveTextContent('fetching');
  });
});
