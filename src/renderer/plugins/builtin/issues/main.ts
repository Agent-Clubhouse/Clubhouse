import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { issueState, IssueListItem, IssueDetail } from './state';
import { MarkdownPreview } from '../files/MarkdownPreview';
import { SendToAgentDialog } from './SendToAgentDialog';

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
    issueState.requestRefresh();
  });
  ctx.subscriptions.push(refreshCmd);

  const createCmd = api.commands.register('create', () => {
    issueState.setCreatingNew(true);
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
  const [needsRefresh, setNeedsRefresh] = useState(false);
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
      setNeedsRefresh(issueState.needsRefresh);
    });
    return () => { mountedRef.current = false; unsub(); };
  }, []);

  // Initial fetch
  const fetchIssues = useCallback(async (page: number, append: boolean) => {
    issueState.setLoading(true);
    setError(null);
    try {
      const perPage = 30;
      const fetchCount = page * perPage + 1;
      const fields = 'number,title,labels,createdAt,updatedAt,author,url,state';
      const r = await api.process.exec('gh', [
        'issue', 'list', '--json', fields, '--limit', String(fetchCount), '--state', 'open',
      ]);
      if (!mountedRef.current) return;
      if (r.exitCode !== 0 || !r.stdout.trim()) {
        setError('Failed to load issues. Is the gh CLI installed and authenticated?');
        return;
      }
      const all: IssueListItem[] = JSON.parse(r.stdout);
      const start = (page - 1) * perPage;
      const sliced = all.slice(start, start + perPage);
      const hasMoreResult = all.length > start + perPage;
      if (append) {
        issueState.appendIssues(sliced);
      } else {
        issueState.setIssues(sliced);
      }
      issueState.page = page;
      issueState.hasMore = hasMoreResult;
      setHasMore(hasMoreResult);
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

  // React to needsRefresh flag
  useEffect(() => {
    if (needsRefresh) {
      issueState.needsRefresh = false;
      fetchIssues(1, false);
    }
  }, [needsRefresh, fetchIssues]);

  const loadMore = useCallback(() => {
    fetchIssues(issueState.page + 1, true);
  }, [fetchIssues]);

  const selectIssue = useCallback((num: number) => {
    issueState.setSelectedIssue(num);
  }, []);

  // ── New Issue ─────────────────────────────────────────────────────────
  const handleNewIssue = useCallback(() => {
    issueState.setCreatingNew(true);
  }, []);

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
          onClick: () => fetchIssues(1, false),
          disabled: loading,
          title: 'Refresh issues',
        }, '\u21BB'),
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
  const [creatingNew, setCreatingNew] = useState(issueState.creatingNew);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAgentDialog, setShowAgentDialog] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);

  // Inline create form state
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newLabels, setNewLabels] = useState('');
  const [creating, setCreating] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editLabels, setEditLabels] = useState('');

  // Comment form state
  const [commentBody, setCommentBody] = useState('');

  // Subscribe to shared state
  useEffect(() => {
    const unsub = issueState.subscribe(() => {
      setSelected(issueState.selectedIssueNumber);
      setCreatingNew(issueState.creatingNew);
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
    const fields = 'number,title,state,url,createdAt,updatedAt,author,labels,body,comments,assignees';
    api.process.exec('gh', ['issue', 'view', String(selected), '--json', fields])
      .then((r) => {
        if (!cancelled) {
          if (r.exitCode === 0 && r.stdout.trim()) {
            setDetail(JSON.parse(r.stdout) as IssueDetail);
          } else {
            setDetail(null);
          }
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
  }, [selected, api, detailVersion]);

  // ── Agent dialog ────────────────────────────────────────────────────
  const openAgentDialog = useCallback(() => {
    setShowAgentDialog(true);
  }, []);

  const closeAgentDialog = useCallback(() => {
    setShowAgentDialog(false);
  }, []);

  // ── Detail refresh ──────────────────────────────────────────────────
  const refreshDetail = useCallback(() => {
    setDetailVersion((v) => v + 1);
  }, []);

  // ── Edit handlers ──────────────────────────────────────────────────
  const startEditing = useCallback(() => {
    if (!detail) return;
    setEditTitle(detail.title);
    setEditBody(detail.body || '');
    setEditLabels(detail.labels.map((l) => l.name).join(', '));
    setEditing(true);
  }, [detail]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!detail) return;
    const num = String(detail.number);
    const args: string[] = ['issue', 'edit', num];

    if (editTitle.trim() !== detail.title) {
      args.push('--title', editTitle.trim());
    }
    if (editBody !== (detail.body || '')) {
      args.push('--body', editBody);
    }

    // Handle label changes
    const oldLabels = new Set(detail.labels.map((l) => l.name));
    const newLabelSet = new Set(editLabels.split(',').map((l) => l.trim()).filter(Boolean));
    for (const l of newLabelSet) {
      if (!oldLabels.has(l)) args.push('--add-label', l);
    }
    for (const l of oldLabels) {
      if (!newLabelSet.has(l)) args.push('--remove-label', l);
    }

    if (args.length === 3) {
      // No changes
      setEditing(false);
      return;
    }

    const r = await api.process.exec('gh', args, { timeout: 30000 });
    if (r.exitCode === 0) {
      api.ui.showNotice('Issue updated');
      setEditing(false);
      refreshDetail();
      issueState.requestRefresh();
    } else {
      api.ui.showError(r.stderr.trim() || 'Failed to update issue');
    }
  }, [detail, editTitle, editBody, editLabels, api, refreshDetail]);

  // ── Comment handler ─────────────────────────────────────────────────
  const handleAddComment = useCallback(async () => {
    if (!detail || !commentBody.trim()) return;
    const r = await api.process.exec('gh', [
      'issue', 'comment', String(detail.number), '--body', commentBody.trim(),
    ], { timeout: 30000 });
    if (r.exitCode === 0) {
      api.ui.showNotice('Comment added');
      setCommentBody('');
      refreshDetail();
    } else {
      api.ui.showError(r.stderr.trim() || 'Failed to add comment');
    }
  }, [detail, commentBody, api, refreshDetail]);

  // ── Close / Reopen handler ──────────────────────────────────────────
  const handleToggleState = useCallback(async () => {
    if (!detail) return;
    const isOpen = detail.state === 'OPEN' || detail.state === 'open';
    const cmd = isOpen ? 'close' : 'reopen';
    const r = await api.process.exec('gh', ['issue', cmd, String(detail.number)], { timeout: 30000 });
    if (r.exitCode === 0) {
      api.ui.showNotice(`Issue ${isOpen ? 'closed' : 'reopened'}`);
      refreshDetail();
      issueState.requestRefresh();
    } else {
      api.ui.showError(r.stderr.trim() || `Failed to ${cmd} issue`);
    }
  }, [detail, api, refreshDetail]);

  // ── Assignee handlers ───────────────────────────────────────────────
  const handleAddAssignee = useCallback(async () => {
    if (!detail) return;
    const login = await api.ui.showInput('GitHub username to assign:');
    if (!login) return;
    const r = await api.process.exec('gh', [
      'issue', 'edit', String(detail.number), '--add-assignee', login.trim(),
    ], { timeout: 30000 });
    if (r.exitCode === 0) {
      api.ui.showNotice(`Assigned ${login.trim()}`);
      refreshDetail();
    } else {
      api.ui.showError(r.stderr.trim() || 'Failed to add assignee');
    }
  }, [detail, api, refreshDetail]);

  const handleRemoveAssignee = useCallback(async (login: string) => {
    if (!detail) return;
    const r = await api.process.exec('gh', [
      'issue', 'edit', String(detail.number), '--remove-assignee', login,
    ], { timeout: 30000 });
    if (r.exitCode === 0) {
      api.ui.showNotice(`Removed ${login}`);
      refreshDetail();
    } else {
      api.ui.showError(r.stderr.trim() || 'Failed to remove assignee');
    }
  }, [detail, api, refreshDetail]);

  // ── Create form handlers ─────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    const args = ['issue', 'create', '--title', newTitle.trim(), '--body', newBody.trim()];
    const labels = newLabels.split(',').map((l) => l.trim()).filter(Boolean);
    for (const l of labels) {
      args.push('--label', l);
    }
    const r = await api.process.exec('gh', args, { timeout: 30000 });
    setCreating(false);
    if (r.exitCode === 0) {
      api.ui.showNotice(`Issue created: ${r.stdout.trim()}`);
      setNewTitle('');
      setNewBody('');
      setNewLabels('');
      issueState.setCreatingNew(false);
      issueState.requestRefresh();
    } else {
      api.ui.showError(r.stderr.trim() || 'Failed to create issue');
    }
  }, [newTitle, newBody, newLabels, api]);

  const handleCancelCreate = useCallback(() => {
    setNewTitle('');
    setNewBody('');
    setNewLabels('');
    issueState.setCreatingNew(false);
  }, []);

  // ── Inline create form ──────────────────────────────────────────────
  if (creatingNew) {
    return React.createElement('div', { className: 'flex flex-col h-full bg-ctp-base' },
      // Header
      React.createElement('div', {
        className: 'flex items-center px-4 py-2.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
      },
        React.createElement('span', { className: 'text-sm font-medium text-ctp-text' }, 'New Issue'),
      ),
      // Form
      React.createElement('div', { className: 'flex-1 overflow-y-auto px-4 py-4 space-y-4' },
        // Title
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-xs font-medium text-ctp-subtext1 mb-1' }, 'Title'),
          React.createElement('input', {
            type: 'text',
            className: 'w-full px-3 py-2 text-sm bg-ctp-mantle text-ctp-text border border-ctp-surface1 rounded-lg focus:outline-none focus:border-ctp-accent placeholder:text-ctp-subtext0',
            placeholder: 'Issue title',
            value: newTitle,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewTitle(e.target.value),
            autoFocus: true,
          }),
        ),
        // Body
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-xs font-medium text-ctp-subtext1 mb-1' }, 'Body'),
          React.createElement('textarea', {
            className: 'w-full px-3 py-2 text-sm bg-ctp-mantle text-ctp-text border border-ctp-surface1 rounded-lg focus:outline-none focus:border-ctp-accent placeholder:text-ctp-subtext0 resize-y',
            placeholder: 'Describe the issue...',
            rows: 10,
            value: newBody,
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setNewBody(e.target.value),
          }),
        ),
        // Labels
        React.createElement('div', null,
          React.createElement('label', { className: 'block text-xs font-medium text-ctp-subtext1 mb-1' }, 'Labels'),
          React.createElement('input', {
            type: 'text',
            className: 'w-full px-3 py-2 text-sm bg-ctp-mantle text-ctp-text border border-ctp-surface1 rounded-lg focus:outline-none focus:border-ctp-accent placeholder:text-ctp-subtext0',
            placeholder: 'bug, enhancement, ...',
            value: newLabels,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewLabels(e.target.value),
          }),
        ),
      ),
      // Bottom bar
      React.createElement('div', {
        className: 'flex items-center justify-end gap-2 px-4 py-3 border-t border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
      },
        React.createElement('button', {
          className: 'px-3 py-1.5 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: handleCancelCreate,
          disabled: creating,
        }, 'Cancel'),
        React.createElement('button', {
          className: 'px-3 py-1.5 text-xs bg-ctp-accent/10 text-ctp-accent border border-ctp-accent/30 rounded hover:bg-ctp-accent/20 transition-colors disabled:opacity-50',
          onClick: handleCreate,
          disabled: creating || !newTitle.trim(),
        }, creating ? 'Creating...' : 'Create Issue'),
      ),
    );
  }

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
      // Issue title (editable or static)
      editing
        ? React.createElement('div', { className: 'flex-1 min-w-0' },
            React.createElement('input', {
              type: 'text',
              className: 'w-full px-2 py-1 text-sm bg-ctp-base text-ctp-text border border-ctp-surface1 rounded focus:outline-none focus:border-ctp-accent',
              value: editTitle,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditTitle(e.target.value),
            }),
          )
        : React.createElement('div', { className: 'flex-1 min-w-0' },
            React.createElement('div', { className: 'flex items-center gap-1.5' },
              React.createElement('span', { className: 'text-xs text-ctp-subtext0' }, `#${detail.number}`),
              React.createElement('span', { className: 'text-sm font-medium text-ctp-text truncate' }, detail.title),
            ),
          ),
      // Edit / Save / Cancel buttons
      editing
        ? React.createElement(React.Fragment, null,
            React.createElement('button', {
              className: 'px-2.5 py-1 text-xs bg-ctp-green/10 text-ctp-green border border-ctp-green/30 rounded hover:bg-ctp-green/20 transition-colors flex-shrink-0',
              onClick: saveEdit,
            }, 'Save'),
            React.createElement('button', {
              className: 'px-2.5 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors flex-shrink-0',
              onClick: cancelEditing,
            }, 'Cancel'),
          )
        : React.createElement(React.Fragment, null,
            React.createElement('button', {
              className: 'px-2.5 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors flex-shrink-0',
              onClick: startEditing,
              title: 'Edit issue',
            }, 'Edit'),
            // View in Browser
            React.createElement('button', {
              className: 'px-2.5 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors flex-shrink-0',
              onClick: () => api.ui.openExternalUrl(detail.url),
              title: 'Open in browser',
            }, 'View in Browser'),
            // Assign to Agent
            React.createElement('button', {
              className: 'px-2.5 py-1 text-xs bg-ctp-accent/10 text-ctp-accent border border-ctp-accent/30 rounded hover:bg-ctp-accent/20 transition-colors flex-shrink-0',
              onClick: openAgentDialog,
            }, 'Assign to Agent'),
          ),
    ),

    // ── Metadata row ──────────────────────────────────────────────────
    React.createElement('div', {
      className: 'flex items-center flex-wrap gap-2 px-4 py-2 border-b border-ctp-surface0 bg-ctp-mantle/50',
    },
      // State badge + close/reopen toggle
      React.createElement('button', {
        className: `text-[10px] px-2 py-0.5 rounded-full border cursor-pointer hover:opacity-80 transition-opacity ${stateColor}`,
        onClick: handleToggleState,
        title: (detail.state === 'OPEN' || detail.state === 'open') ? 'Close issue' : 'Reopen issue',
      }, detail.state),
      // Author
      React.createElement('span', { className: 'text-[10px] text-ctp-subtext0' },
        `by ${detail.author.login}`,
      ),
      // Created date
      React.createElement('span', { className: 'text-[10px] text-ctp-subtext0' },
        `opened ${relativeTime(detail.createdAt)}`,
      ),
      // Labels (editable in edit mode)
      ...(editing
        ? [React.createElement('input', {
            key: '__edit-labels',
            type: 'text',
            className: 'text-[10px] px-2 py-0.5 bg-ctp-base text-ctp-text border border-ctp-surface1 rounded focus:outline-none focus:border-ctp-accent',
            value: editLabels,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEditLabels(e.target.value),
            placeholder: 'Labels (comma separated)',
          })]
        : detail.labels.map((label) =>
            React.createElement('span', {
              key: label.name,
              className: 'text-[9px] px-1.5 py-px rounded-full',
              style: {
                backgroundColor: `${labelColor(label.color)}22`,
                color: labelColor(label.color),
                border: `1px solid ${labelColor(label.color)}44`,
              },
            }, label.name),
          )
      ),
      // Assignees with remove button
      ...detail.assignees.map((a) =>
        React.createElement('span', {
          key: a.login,
          className: 'text-[10px] px-1.5 py-0.5 bg-ctp-surface0 text-ctp-subtext1 rounded inline-flex items-center gap-1',
        },
          a.login,
          React.createElement('button', {
            className: 'text-ctp-subtext0 hover:text-ctp-red transition-colors',
            onClick: () => handleRemoveAssignee(a.login),
            title: `Remove ${a.login}`,
          }, '\u00d7'),
        ),
      ),
      // Add assignee button
      React.createElement('button', {
        className: 'text-[10px] px-1.5 py-0.5 text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
        onClick: handleAddAssignee,
        title: 'Add assignee',
      }, '+ Assignee'),
    ),

    // ── Body ────────────────────────────────────────────────────────────
    editing
      ? React.createElement('div', { className: 'px-4 py-3 border-b border-ctp-surface0' },
          React.createElement('textarea', {
            className: 'w-full px-3 py-2 text-sm bg-ctp-mantle text-ctp-text border border-ctp-surface1 rounded-lg focus:outline-none focus:border-ctp-accent resize-y',
            rows: 10,
            value: editBody,
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setEditBody(e.target.value),
            placeholder: 'Issue body...',
          }),
        )
      : detail.body
        ? React.createElement('div', { className: 'px-4 py-3 border-b border-ctp-surface0' },
            React.createElement(MarkdownPreview, { content: detail.body }),
          )
        : React.createElement('div', { className: 'px-4 py-3 text-xs text-ctp-subtext0 italic border-b border-ctp-surface0' },
            'No description provided.',
          ),

    // ── Comments ────────────────────────────────────────────────────────
    detail.comments.length > 0 && React.createElement('div', { className: 'px-4 py-3 border-b border-ctp-surface0' },
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

    // ── Add comment form ────────────────────────────────────────────────
    React.createElement('div', { className: 'px-4 py-3' },
      React.createElement('div', { className: 'text-xs font-medium text-ctp-text mb-2' }, 'Add a comment'),
      React.createElement('textarea', {
        className: 'w-full px-3 py-2 text-sm bg-ctp-mantle text-ctp-text border border-ctp-surface1 rounded-lg focus:outline-none focus:border-ctp-accent resize-y',
        rows: 3,
        value: commentBody,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setCommentBody(e.target.value),
        placeholder: 'Write a comment...',
      }),
      React.createElement('div', { className: 'flex justify-end mt-2' },
        React.createElement('button', {
          className: 'px-3 py-1.5 text-xs bg-ctp-accent/10 text-ctp-accent border border-ctp-accent/30 rounded hover:bg-ctp-accent/20 transition-colors disabled:opacity-50',
          onClick: handleAddComment,
          disabled: !commentBody.trim(),
        }, 'Comment'),
      ),
    ),

    // ── Agent assignment dialog ────────────────────────────────────────
    showAgentDialog && detail && React.createElement(SendToAgentDialog, {
      api,
      issue: detail,
      onClose: closeAgentDialog,
    }),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
