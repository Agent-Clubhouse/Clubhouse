import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MainPanel, SidebarPanel } from './main';
import { issueState, IssueDetail } from './state';
import { createMockAPI } from '../../testing';

// ── Mock MarkdownPreview ────────────────────────────────────────────────

vi.mock('../files/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'markdown-preview' }, content),
}));

// ── Test data ───────────────────────────────────────────────────────────

const MOCK_ISSUE_DETAIL: IssueDetail = {
  number: 42,
  title: 'Fix login bug',
  state: 'OPEN',
  url: 'https://github.com/test/repo/issues/42',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  author: { login: 'testuser' },
  labels: [{ name: 'bug', color: 'd73a4a' }],
  body: 'Login fails on mobile devices',
  comments: [],
  assignees: [{ login: 'dev1' }],
};

const MOCK_ISSUE_JSON = JSON.stringify(MOCK_ISSUE_DETAIL);

// ── Helpers ─────────────────────────────────────────────────────────────

function createIssuesAPI(overrides?: Record<string, unknown>) {
  const runQuickSpy = vi.fn(async () => 'agent-id');
  const resumeSpy = vi.fn(async () => {});
  const killSpy = vi.fn(async () => {});
  const showNoticeSpy = vi.fn();
  const showErrorSpy = vi.fn();
  const showConfirmSpy = vi.fn(async () => true);
  const showInputSpy = vi.fn(async () => 'user instructions');
  const execSpy = vi.fn(async () => ({ stdout: MOCK_ISSUE_JSON, stderr: '', exitCode: 0 }));
  const listAgentsSpy = vi.fn(() => [
    { id: 'durable-1', name: 'Worker Bee', kind: 'durable' as const, status: 'sleeping' as const, color: '#ff0' },
  ]);

  const api = createMockAPI({
    agents: {
      ...createMockAPI().agents,
      runQuick: runQuickSpy,
      resume: resumeSpy,
      kill: killSpy,
      list: listAgentsSpy,
    },
    ui: {
      ...createMockAPI().ui,
      showNotice: showNoticeSpy,
      showError: showErrorSpy,
      showConfirm: showConfirmSpy,
      showInput: showInputSpy,
    },
    process: { exec: execSpy },
    ...overrides,
  });

  return { api, runQuickSpy, resumeSpy, killSpy, showNoticeSpy, showErrorSpy, showConfirmSpy, showInputSpy, execSpy, listAgentsSpy };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('MainPanel agent assignment', () => {
  beforeEach(() => {
    issueState.reset();
    issueState.setSelectedIssue(42);
  });

  afterEach(() => {
    issueState.reset();
  });

  it('opens SendToAgentDialog with agent list and instructions textarea', async () => {
    const { api } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Open agent dialog
    fireEvent.click(screen.getByText('Assign to Agent'));

    // Dialog should show title, issue reference, instructions textarea, and agent
    expect(screen.getByText('Assign to Agent', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('#42 Fix login bug')).toBeTruthy();
    expect(screen.getByPlaceholderText('Additional instructions (optional)')).toBeTruthy();
    expect(screen.getByText('Worker Bee')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('sleeping agent → click agent → resume with mission', async () => {
    const { api, resumeSpy, showNoticeSpy } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Open agent dialog
    fireEvent.click(screen.getByText('Assign to Agent'));

    // Type instructions in the textarea
    const textarea = screen.getByPlaceholderText('Additional instructions (optional)');
    fireEvent.change(textarea, { target: { value: 'user instructions' } });

    // Click the sleeping durable agent
    fireEvent.click(screen.getByText('Worker Bee'));

    await waitFor(() => {
      expect(resumeSpy).toHaveBeenCalledTimes(1);
    });

    // Verify resume is called with agent id and mission
    expect(resumeSpy.mock.calls[0][0]).toBe('durable-1');
    const opts = resumeSpy.mock.calls[0][1] as { mission: string };
    expect(opts.mission).toContain('GitHub Issue #42');
    expect(opts.mission).toContain('Fix login bug');
    expect(opts.mission).toContain('user instructions');

    expect(showNoticeSpy).toHaveBeenCalledWith('Agent "Worker Bee" assigned to issue #42');
  });

  it('sleeping agent → no instructions → resume without Additional instructions', async () => {
    const { api, resumeSpy } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Open agent dialog
    fireEvent.click(screen.getByText('Assign to Agent'));

    // Don't type anything — just click the agent directly
    fireEvent.click(screen.getByText('Worker Bee'));

    await waitFor(() => {
      expect(resumeSpy).toHaveBeenCalledTimes(1);
    });

    const opts = resumeSpy.mock.calls[0][1] as { mission: string };
    expect(opts.mission).toContain('GitHub Issue #42');
    expect(opts.mission).not.toContain('Additional instructions');
  });

  it('running agent → showConfirm → kill → resume', async () => {
    const { api } = createIssuesAPI({
      agents: {
        ...createMockAPI().agents,
        runQuick: vi.fn(async () => 'agent-id'),
        resume: vi.fn(async () => {}),
        kill: vi.fn(async () => {}),
        list: vi.fn(() => [
          { id: 'durable-1', name: 'Worker Bee', kind: 'durable' as const, status: 'running' as const, color: '#ff0' },
        ]),
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Assign to Agent'));
    fireEvent.click(screen.getByText('Worker Bee'));

    await waitFor(() => {
      expect(api.ui.showConfirm).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(api.agents.kill).toHaveBeenCalledWith('durable-1');
    });

    await waitFor(() => {
      expect(api.agents.resume).toHaveBeenCalledTimes(1);
    });
  });

  it('user cancels confirm → no resume', async () => {
    const showConfirmSpy = vi.fn(async () => false);
    const resumeSpy = vi.fn(async () => {});
    const { api } = createIssuesAPI({
      agents: {
        ...createMockAPI().agents,
        runQuick: vi.fn(async () => 'agent-id'),
        resume: resumeSpy,
        kill: vi.fn(async () => {}),
        list: vi.fn(() => [
          { id: 'durable-1', name: 'Worker Bee', kind: 'durable' as const, status: 'running' as const, color: '#ff0' },
        ]),
      },
      ui: {
        ...createMockAPI().ui,
        showConfirm: showConfirmSpy,
        showNotice: vi.fn(),
        showError: vi.fn(),
        showInput: vi.fn(async () => 'instructions'),
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Assign to Agent'));
    fireEvent.click(screen.getByText('Worker Bee'));

    await waitFor(() => {
      expect(showConfirmSpy).toHaveBeenCalledTimes(1);
    });

    // Give time for any async effects
    await new Promise((r) => setTimeout(r, 50));

    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('user clicks Cancel → dialog closes, no resume', async () => {
    const { api, resumeSpy } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Open agent dialog
    fireEvent.click(screen.getByText('Assign to Agent'));

    // Dialog should be visible
    expect(screen.getByTestId('agent-dialog-overlay')).toBeTruthy();

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Dialog should be closed
    expect(screen.queryByTestId('agent-dialog-overlay')).toBeNull();

    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('no durable agents → empty state message in dialog', async () => {
    const { api } = createIssuesAPI({
      agents: {
        ...createMockAPI().agents,
        list: vi.fn(() => []),
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Assign to Agent'));

    expect(screen.getByText('No durable agents found')).toBeTruthy();
  });

  it('Quick Agent option is not rendered', async () => {
    const { api } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Assign to Agent'));

    expect(screen.queryByText('Quick Agent')).toBeNull();
  });

  it('shows error when resume fails', async () => {
    const resumeSpy = vi.fn(async () => { throw new Error('failed'); });
    const showErrorSpy = vi.fn();
    const { api } = createIssuesAPI({
      agents: {
        ...createMockAPI().agents,
        resume: resumeSpy,
        list: vi.fn(() => [
          { id: 'durable-1', name: 'Worker Bee', kind: 'durable' as const, status: 'sleeping' as const, color: '#ff0' },
        ]),
      },
      ui: {
        ...createMockAPI().ui,
        showError: showErrorSpy,
        showNotice: vi.fn(),
        showInput: vi.fn(async () => ''),
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Assign to Agent'));
    fireEvent.click(screen.getByText('Worker Bee'));

    await waitFor(() => {
      expect(showErrorSpy).toHaveBeenCalledWith('Failed to assign agent to issue #42');
    });
  });
});

describe('MainPanel editing', () => {
  beforeEach(() => {
    issueState.reset();
    issueState.setSelectedIssue(42);
  });

  afterEach(() => {
    issueState.reset();
  });

  it('edit form opens and cancels', async () => {
    const { api } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Click Edit button
    fireEvent.click(screen.getByText('Edit'));

    // Should show Save and Cancel buttons
    expect(screen.getByText('Save')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();

    // Cancel returns to view mode
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeTruthy();
    });
  });

  it('edit form saves via gh issue edit', async () => {
    const execSpy = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: MOCK_ISSUE_JSON, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const showNoticeSpy = vi.fn();
    const { api } = createIssuesAPI({
      process: { exec: execSpy },
      ui: {
        ...createMockAPI().ui,
        showNotice: showNoticeSpy,
        showError: vi.fn(),
        showInput: vi.fn(async () => null),
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Edit'));

    // Change the title
    const titleInput = screen.getByDisplayValue('Fix login bug');
    fireEvent.change(titleInput, { target: { value: 'Updated title' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      // Verify gh issue edit was called
      const editCall = execSpy.mock.calls.find(
        (c: any[]) => c[1]?.[0] === 'issue' && c[1]?.[1] === 'edit',
      );
      expect(editCall).toBeDefined();
      expect(editCall![1]).toContain('--title');
      expect(editCall![1]).toContain('Updated title');
    });

    await waitFor(() => {
      expect(showNoticeSpy).toHaveBeenCalledWith('Issue updated');
    });
  });
});

describe('MainPanel comment form', () => {
  beforeEach(() => {
    issueState.reset();
    issueState.setSelectedIssue(42);
  });

  afterEach(() => {
    issueState.reset();
  });

  it('comment form submits via gh issue comment', async () => {
    const execSpy = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: MOCK_ISSUE_JSON, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const showNoticeSpy = vi.fn();
    const { api } = createIssuesAPI({
      process: { exec: execSpy },
      ui: {
        ...createMockAPI().ui,
        showNotice: showNoticeSpy,
        showError: vi.fn(),
        showInput: vi.fn(async () => null),
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Type a comment
    const textarea = screen.getByPlaceholderText('Write a comment...');
    fireEvent.change(textarea, { target: { value: 'Great fix!' } });

    // Click Comment button
    fireEvent.click(screen.getByText('Comment'));

    await waitFor(() => {
      const commentCall = execSpy.mock.calls.find(
        (c: any[]) => c[1]?.[0] === 'issue' && c[1]?.[1] === 'comment',
      );
      expect(commentCall).toBeDefined();
      expect(commentCall![1]).toContain('--body');
      expect(commentCall![1]).toContain('Great fix!');
    });

    await waitFor(() => {
      expect(showNoticeSpy).toHaveBeenCalledWith('Comment added');
    });
  });

  it('comment button is disabled when empty', async () => {
    const { api } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    const commentBtn = screen.getByText('Comment');
    expect(commentBtn).toHaveProperty('disabled', true);
  });
});

describe('MainPanel close/reopen', () => {
  beforeEach(() => {
    issueState.reset();
    issueState.setSelectedIssue(42);
  });

  afterEach(() => {
    issueState.reset();
  });

  it('close/reopen toggle calls gh issue close', async () => {
    const execSpy = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: MOCK_ISSUE_JSON, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const showNoticeSpy = vi.fn();
    const { api } = createIssuesAPI({
      process: { exec: execSpy },
      ui: {
        ...createMockAPI().ui,
        showNotice: showNoticeSpy,
        showError: vi.fn(),
        showInput: vi.fn(async () => null),
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Click the state badge to toggle
    fireEvent.click(screen.getByText('OPEN'));

    await waitFor(() => {
      const closeCall = execSpy.mock.calls.find(
        (c: any[]) => c[1]?.[0] === 'issue' && c[1]?.[1] === 'close',
      );
      expect(closeCall).toBeDefined();
    });

    await waitFor(() => {
      expect(showNoticeSpy).toHaveBeenCalledWith('Issue closed');
    });
  });
});

describe('MainPanel assignees', () => {
  beforeEach(() => {
    issueState.reset();
    issueState.setSelectedIssue(42);
  });

  afterEach(() => {
    issueState.reset();
  });

  it('add assignee calls gh issue edit --add-assignee', async () => {
    const showInputSpy = vi.fn(async () => 'newuser');
    const execSpy = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: MOCK_ISSUE_JSON, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const showNoticeSpy = vi.fn();
    const { api } = createIssuesAPI({
      process: { exec: execSpy },
      ui: {
        ...createMockAPI().ui,
        showNotice: showNoticeSpy,
        showError: vi.fn(),
        showInput: showInputSpy,
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('+ Assignee'));

    await waitFor(() => {
      expect(showInputSpy).toHaveBeenCalledWith('GitHub username to assign:');
    });

    await waitFor(() => {
      const addCall = execSpy.mock.calls.find(
        (c: any[]) => c[1]?.[0] === 'issue' && c[1]?.[1] === 'edit' && c[1]?.includes('--add-assignee'),
      );
      expect(addCall).toBeDefined();
      expect(addCall![1]).toContain('newuser');
    });

    await waitFor(() => {
      expect(showNoticeSpy).toHaveBeenCalledWith('Assigned newuser');
    });
  });

  it('remove assignee calls gh issue edit --remove-assignee', async () => {
    const execSpy = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: MOCK_ISSUE_JSON, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const showNoticeSpy = vi.fn();
    const { api } = createIssuesAPI({
      process: { exec: execSpy },
      ui: {
        ...createMockAPI().ui,
        showNotice: showNoticeSpy,
        showError: vi.fn(),
        showInput: vi.fn(async () => null),
      },
    });

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Click remove button on existing assignee (x)
    const removeBtn = screen.getByTitle('Remove dev1');
    fireEvent.click(removeBtn);

    await waitFor(() => {
      const removeCall = execSpy.mock.calls.find(
        (c: any[]) => c[1]?.[0] === 'issue' && c[1]?.[1] === 'edit' && c[1]?.includes('--remove-assignee'),
      );
      expect(removeCall).toBeDefined();
      expect(removeCall![1]).toContain('dev1');
    });

    await waitFor(() => {
      expect(showNoticeSpy).toHaveBeenCalledWith('Removed dev1');
    });
  });
});

describe('SidebarPanel', () => {
  const EMPTY_ISSUE_LIST = JSON.stringify([]);
  const ISSUE_LIST = JSON.stringify([
    { number: 1, title: 'Issue 1', state: 'OPEN', url: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), author: { login: 'a' }, labels: [] },
  ]);

  beforeEach(() => {
    issueState.reset();
  });

  afterEach(() => {
    issueState.reset();
  });

  it('+ New sets creatingNew state for inline form', async () => {
    const execSpy = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return { stdout: EMPTY_ISSUE_LIST, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const api = createMockAPI({
      process: { exec: execSpy },
    });

    render(React.createElement(SidebarPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('+ New')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('+ New'));

    expect(issueState.creatingNew).toBe(true);
    expect(issueState.selectedIssueNumber).toBeNull();
  });

  it('refresh button renders and triggers fetch', async () => {
    const execSpy = vi.fn(async () => ({ stdout: ISSUE_LIST, stderr: '', exitCode: 0 }));

    const api = createMockAPI({
      process: { exec: execSpy },
    });

    render(React.createElement(SidebarPanel, { api }));

    await waitFor(() => {
      expect(screen.getByTitle('Refresh issues')).toBeTruthy();
    });

    // Clear initial fetch calls
    execSpy.mockClear();

    // Click refresh
    fireEvent.click(screen.getByTitle('Refresh issues'));

    await waitFor(() => {
      expect(execSpy).toHaveBeenCalledTimes(1);
      const call = execSpy.mock.calls[0];
      expect(call[1]).toContain('issue');
      expect(call[1]).toContain('list');
    });
  });

  it('post-create sidebar refresh without clearing list', async () => {
    const execSpy = vi.fn(async () => ({ stdout: ISSUE_LIST, stderr: '', exitCode: 0 }));

    const api = createMockAPI({
      process: { exec: execSpy },
    });

    render(React.createElement(SidebarPanel, { api }));

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText('Issue 1')).toBeTruthy();
    });

    // Simulate post-create refresh via requestRefresh
    act(() => {
      issueState.requestRefresh();
    });

    // Issues should still be visible (not cleared)
    expect(screen.getByText('Issue 1')).toBeTruthy();

    // A new fetch should be triggered
    await waitFor(() => {
      // Initial fetch + refresh fetch
      expect(execSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
