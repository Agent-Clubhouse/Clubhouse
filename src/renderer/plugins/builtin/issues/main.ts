import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { PluginContext, PluginAPI, PluginModule, AgentInfo, GitHubIssueDetail } from '../../../../shared/plugin-types';
import { issueState, IssueListItem } from './state';
import { MarkdownPreview } from '../files/MarkdownPreview';

// ── Helpers ─────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  const diffMo = Math.floor(diffD / 30);
  return `${diffMo}mo ago`;
}

function buildAgentPrompt(issue: GitHubIssueDetail): string {
  const labels = issue.labels.map((l) => l.name).join(', ');
  return [
    'Review and prepare a fix for the following GitHub issue:',
    '',
    `GitHub Issue #${issue.number}: ${issue.title}`,
    '',
    issue.body || '(no description)',
    '',
    labels ? `Labels: ${labels}` : '',
    `Author: ${issue.author.login}`,
    `State: ${issue.state}`,
  ].filter(Boolean).join('\n');
}

/** Pad a hex color string from gh (e.g. "d73a4a") to proper CSS. */
function labelColor(hex: string): string {
  if (!hex) return '#888';
  return hex.startsWith('#') ? hex : `#${hex}`;
}

// ── activate / deactivate ───────────────────────────────────────────────

let pluginApi: PluginAPI | null = null;

export function activate(ctx: PluginContext, api: PluginAPI): void {
  pluginApi = api;

  const refreshCmd = api.commands.register('refresh', () => {
    issueState.page = 1;
    issueState.setIssues([]);
    issueState.notify();
  });
  ctx.subscriptions.push(refreshCmd);

  const createCmd = api.commands.register('create', async () => {
    const title = await api.ui.showInput('Issue title');
    if (!title) return;
    const body = await api.ui.showInput('Issue body (optional)', '');
    const result = await api.github.createIssue(title, body ?? '');
    if (result.ok) {
      api.ui.showNotice(`Issue created: ${result.url}`);
      issueState.page = 1;
      issueState.setIssues([]);
    } else {
      api.ui.showError(result.message || 'Failed to create issue');
    }
  });
  ctx.subscriptions.push(createCmd);
}

export function deactivate(): void {
  pluginApi = null;
  issueState.reset();
}

// ── SidebarPanel (issue list) ───────────────────────────────────────────

export function SidebarPanel({ api }: { api: PluginAPI }) {
  const [issues, setIssues] = useState<IssueListItem[]>(issueState.issues);
  const [selected, setSelected] = useState<number | null>(issueState.selectedIssueNumber);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(issueState.hasMore);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Subscribe to shared state
  useEffect(() => {
    mountedRef.current = true;
    const unsub = issueState.subscribe(() => {
      if (!mountedRef.current) return;
      setIssues([...issueState.issues]);
      setSelected(issueState.selectedIssueNumber);
      setLoading(issueState.loading);
      setHasMore(issueState.hasMore);
    });
    return () => { mountedRef.current = false; unsub(); };
  }, []);

  // Initial fetch
  const fetchIssues = useCallback(async (page: number, append: boolean) => {
    issueState.setLoading(true);
    setError(null);
    try {
      const result = await api.github.listIssues({
        page,
        perPage: 30,
        state: 'open',
      });
      if (!mountedRef.current) return;
      if (append) {
        issueState.appendIssues(result.issues);
      } else {
        issueState.setIssues(result.issues);
      }
      issueState.page = page;
      issueState.hasMore = result.hasMore;
      setHasMore(result.hasMore);
    } catch {
      if (!mountedRef.current) return;
      setError('Failed to load issues. Is the gh CLI installed and authenticated?');
    } finally {
      issueState.setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (issueState.issues.length === 0) {
      fetchIssues(1, false);
    }
  }, [fetchIssues]);

  const loadMore = useCallback(() => {
    fetchIssues(issueState.page + 1, true);
  }, [fetchIssues]);

  const selectIssue = useCallback((num: number) => {
    issueState.setSelectedIssue(num);
  }, []);

  // ── New Issue ─────────────────────────────────────────────────────────
  const handleNewIssue = useCallback(async () => {
    const title = await api.ui.showInput('Issue title');
    if (!title) return;
    const body = await api.ui.showInput('Issue body (optional)', '');
    const result = await api.github.createIssue(title, body ?? '');
    if (result.ok) {
      api.ui.showNotice(`Issue created: ${result.url}`);
      fetchIssues(1, false);
    } else {
      api.ui.showError(result.message || 'Failed to create issue');
    }
  }, [api, fetchIssues]);

  // ── New Issue with Agent ──────────────────────────────────────────────
  const handleNewIssueAgent = useCallback(async () => {
    const mission = [
      'Help the user create a well-structured GitHub issue for this project.',
      'Ask them to describe the problem or feature request, then use `gh issue create` to file it.',
      'Include a clear title, detailed body with steps to reproduce (for bugs), and suggest appropriate labels.',
    ].join(' ');
    try {
      await api.agents.runQuick(mission);
      api.ui.showNotice('Agent launched to help create an issue');
    } catch {
      api.ui.showError('Failed to launch agent');
    }
  }, [api]);

  // ── Error / empty state ───────────────────────────────────────────────
  if (error) {
    return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-mantle' },
      React.createElement('div', { className: 'px-3 py-4 text-xs text-ctp-subtext0 text-center' },
        React.createElement('div', { className: 'mb-2 text-ctp-peach' }, 'Could not load issues'),
        React.createElement('div', null, error),
        React.createElement('button', {
          className: 'mt-3 px-3 py-1 text-xs bg-ctp-surface0 text-ctp-text rounded hover:bg-ctp-surface1 transition-colors',
          onClick: () => fetchIssues(1, false),
        }, 'Retry'),
      ),
    );
  }

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-mantle' },
    // Header
    React.createElement('div', { className: 'flex items-center justify-between px-3 py-2 border-b border-ctp-surface0' },
      React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, 'Issues'),
      React.createElement('div', { className: 'flex items-center gap-1' },
        React.createElement('button', {
          className: 'px-2 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: handleNewIssue,
          title: 'Create a new issue',
        }, '+ New'),
        React.createElement('button', {
          className: 'px-2 py-0.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: handleNewIssueAgent,
          title: 'Create an issue with AI agent assistance',
        }, '+ Agent'),
      ),
    ),

    // Issue list
    React.createElement('div', { className: 'flex-1 overflow-y-auto' },
      loading && issues.length === 0
        ? React.createElement('div', { className: 'px-3 py-4 text-xs text-ctp-subtext0 text-center' }, 'Loading issues...')
        : issues.length === 0
          ? React.createElement('div', { className: 'px-3 py-4 text-xs text-ctp-subtext0 text-center' }, 'No open issues')
          : React.createElement('div', { className: 'py-0.5' },
              issues.map((issue) =>
                React.createElement('div', {
                  key: issue.number,
                  className: `px-3 py-2 cursor-pointer transition-colors ${
                    issue.number === selected ? 'bg-surface-1 text-ctp-text' : 'hover:bg-surface-0'
                  }`,
                  onClick: () => selectIssue(issue.number),
                },
                  // Top row: number + title
                  React.createElement('div', { className: 'flex items-center gap-1.5 min-w-0' },
                    React.createElement('span', { className: 'text-[10px] text-ctp-subtext0 flex-shrink-0' }, `#${issue.number}`),
                    React.createElement('span', { className: 'text-xs text-ctp-text truncate' }, issue.title),
                  ),
                  // Bottom row: labels + time
                  React.createElement('div', { className: 'flex items-center gap-1.5 mt-1' },
                    ...issue.labels.slice(0, 3).map((label) =>
                      React.createElement('span', {
                        key: label.name,
                        className: 'text-[9px] px-1.5 py-px rounded-full flex-shrink-0',
                        style: {
                          backgroundColor: `${labelColor(label.color)}22`,
                          color: labelColor(label.color),
                          border: `1px solid ${labelColor(label.color)}44`,
                        },
                      }, label.name),
                    ),
                    React.createElement('span', { className: 'text-[10px] text-ctp-subtext0 ml-auto flex-shrink-0' }, relativeTime(issue.updatedAt)),
                  ),
                ),
              ),
              // Load more button
              hasMore && React.createElement('div', { className: 'px-3 py-2 text-center' },
                React.createElement('button', {
                  className: 'px-3 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
                  onClick: loadMore,
                  disabled: loading,
                }, loading ? 'Loading...' : 'Load more'),
              ),
            ),
    ),
  );
}

// ── MainPanel (issue detail) ────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const [selected, setSelected] = useState<number | null>(issueState.selectedIssueNumber);
  const [detail, setDetail] = useState<GitHubIssueDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [durableAgents, setDurableAgents] = useState<AgentInfo[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  // Subscribe to shared state
  useEffect(() => {
    const unsub = issueState.subscribe(() => {
      setSelected(issueState.selectedIssueNumber);
    });
    return unsub;
  }, []);

  // Fetch detail when selection changes
  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.github.viewIssue(selected)
      .then((result) => {
        if (!cancelled) {
          setDetail(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [selected, api]);

  // Close agent menu on outside click
  useEffect(() => {
    if (!showAgentMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowAgentMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAgentMenu]);

  // ── Agent assignment ──────────────────────────────────────────────────
  const handleQuickAgent = useCallback(async () => {
    if (!detail) return;
    setShowAgentMenu(false);
    const prompt = buildAgentPrompt(detail);
    try {
      await api.agents.runQuick(prompt);
      api.ui.showNotice(`Quick agent launched for issue #${detail.number}`);
    } catch {
      api.ui.showError('Failed to launch quick agent');
    }
  }, [detail, api]);

  const handleDurableAgent = useCallback(async (agent: AgentInfo) => {
    if (!detail) return;
    setShowAgentMenu(false);
    const prompt = buildAgentPrompt(detail);

    if (agent.status === 'running') {
      const ok = await api.ui.showConfirm(
        'This agent is running. Restarting will interrupt its work. Continue?'
      );
      if (!ok) return;
      await api.agents.kill(agent.id);
    }

    try {
      await api.agents.resume(agent.id);
      api.ui.showNotice(`Issue #${detail.number} assigned to ${agent.name}`);
    } catch {
      api.ui.showError(`Failed to assign to ${agent.name}`);
    }
  }, [detail, api]);

  const openAgentMenu = useCallback(async () => {
    const agents = api.agents.list().filter((a) => a.kind === 'durable');
    setDurableAgents(agents);
    setShowAgentMenu(true);
  }, [api]);

  // ── Empty state ───────────────────────────────────────────────────────
  if (selected === null) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs',
    }, 'Select an issue to view details');
  }

  if (loading) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs',
    }, 'Loading issue...');
  }

  if (!detail) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs',
    }, 'Failed to load issue details');
  }

  // ── State badge color ─────────────────────────────────────────────────
  const stateColor = detail.state === 'OPEN' || detail.state === 'open'
    ? 'bg-ctp-green/15 text-ctp-green border-ctp-green/30'
    : 'bg-ctp-mauve/15 text-ctp-mauve border-ctp-mauve/30';

  return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-base overflow-y-auto' },
    // ── Header bar ────────────────────────────────────────────────────
    React.createElement('div', {
      className: 'flex items-center gap-2 px-4 py-2.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
    },
      // Issue title
      React.createElement('div', { className: 'flex-1 min-w-0' },
        React.createElement('div', { className: 'flex items-center gap-1.5' },
          React.createElement('span', { className: 'text-xs text-ctp-subtext0' }, `#${detail.number}`),
          React.createElement('span', { className: 'text-sm font-medium text-ctp-text truncate' }, detail.title),
        ),
      ),
      // View in Browser
      React.createElement('button', {
        className: 'px-2.5 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors flex-shrink-0',
        onClick: () => api.ui.openExternalUrl(detail.url),
        title: 'Open in browser',
      }, 'View in Browser'),
      // Assign to Agent
      React.createElement('div', { className: 'relative flex-shrink-0', ref: menuRef },
        React.createElement('button', {
          className: 'px-2.5 py-1 text-xs bg-ctp-accent/10 text-ctp-accent border border-ctp-accent/30 rounded hover:bg-ctp-accent/20 transition-colors',
          onClick: openAgentMenu,
        }, 'Assign to Agent'),
        // Dropdown menu
        showAgentMenu && React.createElement('div', {
          className: 'absolute right-0 top-full mt-1 w-56 bg-ctp-mantle border border-ctp-surface1 rounded-lg shadow-lg z-50 py-1',
        },
          // Quick Agent option
          React.createElement('button', {
            className: 'w-full text-left px-3 py-2 text-xs text-ctp-text hover:bg-ctp-surface0 transition-colors',
            onClick: handleQuickAgent,
          },
            React.createElement('div', { className: 'font-medium' }, 'Quick Agent'),
            React.createElement('div', { className: 'text-[10px] text-ctp-subtext0 mt-0.5' }, 'Spawn a quick agent to fix this issue'),
          ),
          // Divider
          durableAgents.length > 0 && React.createElement('div', {
            className: 'border-t border-ctp-surface0 my-1',
          }),
          // Durable agents
          ...durableAgents.map((agent) =>
            React.createElement('button', {
              key: agent.id,
              className: 'w-full text-left px-3 py-2 text-xs text-ctp-text hover:bg-ctp-surface0 transition-colors',
              onClick: () => handleDurableAgent(agent),
            },
              React.createElement('div', { className: 'flex items-center gap-1.5' },
                React.createElement('span', {
                  className: 'w-2 h-2 rounded-full flex-shrink-0',
                  style: { backgroundColor: agent.color || 'var(--ctp-accent)' },
                }),
                React.createElement('span', { className: 'font-medium' }, agent.name),
                agent.status === 'running' && React.createElement('span', {
                  className: 'text-[9px] px-1 py-px rounded bg-ctp-yellow/15 text-ctp-yellow',
                }, 'running'),
              ),
              React.createElement('div', { className: 'text-[10px] text-ctp-subtext0 mt-0.5 pl-3.5' }, 'Assign issue to this agent'),
            ),
          ),
        ),
      ),
    ),

    // ── Metadata row ──────────────────────────────────────────────────
    React.createElement('div', {
      className: 'flex items-center flex-wrap gap-2 px-4 py-2 border-b border-ctp-surface0 bg-ctp-mantle/50',
    },
      // State badge
      React.createElement('span', {
        className: `text-[10px] px-2 py-0.5 rounded-full border ${stateColor}`,
      }, detail.state),
      // Author
      React.createElement('span', { className: 'text-[10px] text-ctp-subtext0' },
        `by ${detail.author.login}`,
      ),
      // Created date
      React.createElement('span', { className: 'text-[10px] text-ctp-subtext0' },
        `opened ${relativeTime(detail.createdAt)}`,
      ),
      // Labels
      ...detail.labels.map((label) =>
        React.createElement('span', {
          key: label.name,
          className: 'text-[9px] px-1.5 py-px rounded-full',
          style: {
            backgroundColor: `${labelColor(label.color)}22`,
            color: labelColor(label.color),
            border: `1px solid ${labelColor(label.color)}44`,
          },
        }, label.name),
      ),
      // Assignees
      ...detail.assignees.map((a) =>
        React.createElement('span', {
          key: a.login,
          className: 'text-[10px] px-1.5 py-0.5 bg-ctp-surface0 text-ctp-subtext1 rounded',
        }, a.login),
      ),
    ),

    // ── Body ────────────────────────────────────────────────────────────
    detail.body
      ? React.createElement('div', { className: 'px-4 py-3 border-b border-ctp-surface0' },
          React.createElement(MarkdownPreview, { content: detail.body }),
        )
      : React.createElement('div', { className: 'px-4 py-3 text-xs text-ctp-subtext0 italic border-b border-ctp-surface0' },
          'No description provided.',
        ),

    // ── Comments ────────────────────────────────────────────────────────
    detail.comments.length > 0 && React.createElement('div', { className: 'px-4 py-3' },
      React.createElement('div', { className: 'text-xs font-medium text-ctp-text mb-3' },
        `${detail.comments.length} comment${detail.comments.length === 1 ? '' : 's'}`,
      ),
      React.createElement('div', { className: 'space-y-3' },
        ...detail.comments.map((comment, i) =>
          React.createElement('div', {
            key: i,
            className: 'bg-ctp-mantle rounded-lg border border-ctp-surface0 overflow-hidden',
          },
            // Comment header
            React.createElement('div', {
              className: 'flex items-center gap-2 px-3 py-1.5 bg-ctp-surface0/50 border-b border-ctp-surface0',
            },
              React.createElement('span', { className: 'text-xs font-medium text-ctp-text' }, comment.author.login),
              React.createElement('span', { className: 'text-[10px] text-ctp-subtext0' }, relativeTime(comment.createdAt)),
            ),
            // Comment body
            React.createElement('div', { className: 'px-3 py-2' },
              React.createElement(MarkdownPreview, { content: comment.body }),
            ),
          ),
        ),
      ),
    ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
