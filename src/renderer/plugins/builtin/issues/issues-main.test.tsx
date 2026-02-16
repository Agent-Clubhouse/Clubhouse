import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  assignees: [],
};

const MOCK_ISSUE_JSON = JSON.stringify(MOCK_ISSUE_DETAIL);

// ── Helpers ─────────────────────────────────────────────────────────────

function createIssuesAPI(overrides?: Record<string, unknown>) {
  const runQuickSpy = vi.fn(async () => 'agent-id');
  const showNoticeSpy = vi.fn();
  const showErrorSpy = vi.fn();
  const execSpy = vi.fn(async () => ({ stdout: MOCK_ISSUE_JSON, stderr: '', exitCode: 0 }));
  const listAgentsSpy = vi.fn(() => [
    { id: 'durable-1', name: 'Worker Bee', kind: 'durable' as const, status: 'sleeping' as const, color: '#ff0' },
  ]);

  const api = createMockAPI({
    agents: {
      ...createMockAPI().agents,
      runQuick: runQuickSpy,
      list: listAgentsSpy,
    },
    ui: {
      ...createMockAPI().ui,
      showNotice: showNoticeSpy,
      showError: showErrorSpy,
    },
    process: { exec: execSpy },
    ...overrides,
  });

  return { api, runQuickSpy, showNoticeSpy, showErrorSpy, execSpy, listAgentsSpy };
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

  it('quick agent button calls runQuick with issue prompt', async () => {
    const { api, runQuickSpy, showNoticeSpy } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    // Wait for issue detail to load
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Open agent menu
    fireEvent.click(screen.getByText('Assign to Agent'));

    // Click Quick Agent
    fireEvent.click(screen.getByText('Quick Agent'));

    await waitFor(() => {
      expect(runQuickSpy).toHaveBeenCalledTimes(1);
    });

    // Verify the prompt contains issue context
    const prompt = runQuickSpy.mock.calls[0][0] as string;
    expect(prompt).toContain('GitHub Issue #42');
    expect(prompt).toContain('Fix login bug');
    expect(prompt).toContain('Login fails on mobile devices');
    expect(prompt).toContain('testuser');
    expect(prompt).toContain('bug');

    expect(showNoticeSpy).toHaveBeenCalledWith('Quick agent launched for issue #42');
  });

  it('durable agent button calls runQuick with issue prompt', async () => {
    const { api, runQuickSpy, showNoticeSpy } = createIssuesAPI();

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    // Open agent menu
    fireEvent.click(screen.getByText('Assign to Agent'));

    // Click the durable agent
    fireEvent.click(screen.getByText('Worker Bee'));

    await waitFor(() => {
      expect(runQuickSpy).toHaveBeenCalledTimes(1);
    });

    // Verify the prompt contains issue context (the same bug we fixed)
    const prompt = runQuickSpy.mock.calls[0][0] as string;
    expect(prompt).toContain('GitHub Issue #42');
    expect(prompt).toContain('Fix login bug');
    expect(prompt).toContain('Login fails on mobile devices');

    expect(showNoticeSpy).toHaveBeenCalledWith('Quick agent launched for issue #42 (via Worker Bee)');
  });

  it('shows error when runQuick fails', async () => {
    const { api, runQuickSpy, showErrorSpy } = createIssuesAPI();
    runQuickSpy.mockRejectedValueOnce(new Error('Agent spawn failed'));

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Assign to Agent'));
    fireEvent.click(screen.getByText('Quick Agent'));

    await waitFor(() => {
      expect(showErrorSpy).toHaveBeenCalledWith('Failed to launch quick agent');
    });
  });
});

describe('SidebarPanel new issue', () => {
  const EMPTY_ISSUE_LIST = JSON.stringify([]);

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
});
