import React, { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import type { GitInfo, GitLogEntry, GitStatusFile } from '../../../../shared/types';
import { gitState } from './state';
import { GitCanvasWidget } from './GitCanvasWidget';

const GIT_POLL_INTERVAL_MS = 3000;

// ── Status helpers ───────────────────────────────────────────────────

interface StatusInfo {
  label: string;
  color: string;
  short: string;
}

function statusInfo(code: string): StatusInfo {
  const c = code.trim();
  if (c === '??' || c === '?') return { label: 'Untracked', color: 'text-ctp-blue', short: 'U' };
  if (c.startsWith('A') || c === 'A') return { label: 'Added', color: 'text-ctp-green', short: 'A' };
  if (c.startsWith('D') || c === 'D') return { label: 'Deleted', color: 'text-ctp-red', short: 'D' };
  if (c.startsWith('M') || c === 'M') return { label: 'Modified', color: 'text-ctp-yellow', short: 'M' };
  if (c.startsWith('R')) return { label: 'Renamed', color: 'text-ctp-mauve', short: 'R' };
  if (c.startsWith('C')) return { label: 'Copied', color: 'text-ctp-teal', short: 'C' };
  return { label: 'Changed', color: 'text-ctp-overlay0', short: '~' };
}

// ── Activate / Deactivate ────────────────────────────────────────────

export function activate(ctx: PluginContext, api: PluginAPI): void {
  ctx.subscriptions.push(
    api.commands.register('refresh', () => {
      // Trigger re-fetch — the SidebarPanel polls via gitState
    }),
  );

  ctx.subscriptions.push(
    api.canvas.registerWidgetType({
      id: 'git-status',
      component: GitCanvasWidget,
      generateDisplayName: (metadata) => {
        if (metadata.worktreePath && typeof metadata.worktreePath === 'string') {
          const segments = metadata.worktreePath.replace(/\/+$/, '').split('/');
          return segments[segments.length - 1] || 'Git Status';
        }
        return 'Git Status';
      },
    }),
  );
}

export function deactivate(): void {
  gitState.reset();
}

// ── Shared hook ──────────────────────────────────────────────────────

function useGitState() {
  const subscribe = useCallback((cb: () => void) => gitState.subscribe(cb), []);
  const getGitInfo = useCallback(() => gitState.gitInfo, []);
  const getCommitLog = useCallback(() => gitState.commitLog, []);
  const getSelectedFile = useCallback(() => gitState.selectedFile, []);
  const getSelectedCommit = useCallback(() => gitState.selectedCommit, []);
  const getCommitMessage = useCallback(() => gitState.commitMessage, []);
  const getExpandedSections = useCallback(() => gitState.expandedSections, []);
  const getSelectedCommitFiles = useCallback(() => gitState.selectedCommitFiles, []);

  return {
    gitInfo: useSyncExternalStore(subscribe, getGitInfo),
    commitLog: useSyncExternalStore(subscribe, getCommitLog),
    selectedFile: useSyncExternalStore(subscribe, getSelectedFile),
    selectedCommit: useSyncExternalStore(subscribe, getSelectedCommit),
    commitMessage: useSyncExternalStore(subscribe, getCommitMessage),
    expandedSections: useSyncExternalStore(subscribe, getExpandedSections),
    selectedCommitFiles: useSyncExternalStore(subscribe, getSelectedCommitFiles),
  };
}

// ── Sidebar Panel ────────────────────────────────────────────────────

export function SidebarPanel({ api }: { api: PluginAPI }) {
  const { gitInfo, commitLog, commitMessage, expandedSections } = useGitState();
  const projectPath = api.context.projectPath || '';
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchGitInfo = useCallback(() => {
    if (!projectPath || document.hidden) return;
    window.clubhouse.git.info(projectPath).then((info: GitInfo) => {
      gitState.setGitInfo(info);
    }).catch(() => {});
  }, [projectPath]);

  const fetchLog = useCallback(() => {
    if (!projectPath) return;
    window.clubhouse.git.log(projectPath, 50, 0).then((log: GitLogEntry[]) => {
      gitState.setCommitLog(log);
    }).catch(() => {});
  }, [projectPath]);

  // Initial fetch + polling
  useEffect(() => {
    fetchGitInfo();
    fetchLog();
    pollRef.current = setInterval(fetchGitInfo, GIT_POLL_INTERVAL_MS);
    const onVisibility = () => { if (!document.hidden) { fetchGitInfo(); fetchLog(); } };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchGitInfo, fetchLog]);

  // File actions
  const handleStage = useCallback(async (filePath: string) => {
    await window.clubhouse.git.stage(projectPath, filePath);
    fetchGitInfo();
  }, [projectPath, fetchGitInfo]);

  const handleUnstage = useCallback(async (filePath: string) => {
    await window.clubhouse.git.unstage(projectPath, filePath);
    fetchGitInfo();
  }, [projectPath, fetchGitInfo]);

  const handleStageAll = useCallback(async () => {
    await window.clubhouse.git.stageAll(projectPath);
    fetchGitInfo();
  }, [projectPath, fetchGitInfo]);

  const handleUnstageAll = useCallback(async () => {
    await window.clubhouse.git.unstageAll(projectPath);
    fetchGitInfo();
  }, [projectPath, fetchGitInfo]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    const result = await window.clubhouse.git.commit(projectPath, commitMessage);
    if (result.ok) {
      gitState.setCommitMessage('');
      fetchGitInfo();
      fetchLog();
    }
  }, [projectPath, commitMessage, fetchGitInfo, fetchLog]);

  const handlePush = useCallback(async () => {
    await window.clubhouse.git.push(projectPath);
    fetchGitInfo();
  }, [projectPath, fetchGitInfo]);

  const handlePull = useCallback(async () => {
    await window.clubhouse.git.pull(projectPath);
    fetchGitInfo();
    fetchLog();
  }, [projectPath, fetchGitInfo, fetchLog]);

  const handleSelectFile = useCallback((filePath: string) => {
    gitState.setSelectedCommit(null);
    gitState.setSelectedFile(filePath);
  }, []);

  const handleSelectCommit = useCallback(async (hash: string) => {
    gitState.setSelectedFile(null);
    gitState.setSelectedCommit(hash);
    try {
      const detail = await window.clubhouse.git.showCommit(projectPath, hash);
      gitState.setSelectedCommitFiles(detail.files);
    } catch {
      gitState.setSelectedCommitFiles([]);
    }
  }, [projectPath]);

  const handleCheckout = useCallback(async (branch: string) => {
    await window.clubhouse.git.checkout(projectPath, branch);
    fetchGitInfo();
    fetchLog();
  }, [projectPath, fetchGitInfo, fetchLog]);

  const handleStash = useCallback(async () => {
    await window.clubhouse.git.stash(projectPath);
    fetchGitInfo();
  }, [projectPath, fetchGitInfo]);

  const handleStashPop = useCallback(async () => {
    await window.clubhouse.git.stashPop(projectPath);
    fetchGitInfo();
  }, [projectPath, fetchGitInfo]);

  if (!gitInfo) {
    return h('div', { className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs' }, 'Loading git status...');
  }

  if (!gitInfo.hasGit) {
    return h('div', { className: 'flex items-center justify-center h-full text-ctp-overlay0 text-xs p-4 text-center' }, 'Not a git repository');
  }

  const staged = gitInfo.status.filter((f) => f.staged);
  const unstaged = gitInfo.status.filter((f) => !f.staged && f.status !== '??' && f.status !== '?');
  const untracked = gitInfo.status.filter((f) => f.status === '??' || f.status === '?');

  return h('div', { className: 'flex flex-col h-full bg-ctp-mantle overflow-y-auto', 'data-testid': 'git-sidebar-panel' },
    // Branch header
    h('div', { className: 'px-3 py-2 border-b border-ctp-surface0 flex items-center gap-2' },
      h('span', { className: 'text-xs font-medium text-ctp-text truncate' }, gitInfo.branch),
      gitInfo.ahead > 0 && h('span', { className: 'text-[9px] text-ctp-green' }, `↑${gitInfo.ahead}`),
      gitInfo.behind > 0 && h('span', { className: 'text-[9px] text-ctp-red' }, `↓${gitInfo.behind}`),
      h('span', { className: 'flex-1' }),
      h('button', { className: 'text-[10px] text-ctp-subtext0 hover:text-ctp-text px-1', onClick: handlePull, title: 'Pull' }, '↓'),
      h('button', { className: 'text-[10px] text-ctp-subtext0 hover:text-ctp-text px-1', onClick: handlePush, title: 'Push' }, '↑'),
    ),
    // Staged
    renderFileSection('Staged', 'staged', staged, expandedSections, handleSelectFile, handleUnstage, null),
    // Unstaged
    renderFileSection('Changes', 'unstaged', unstaged, expandedSections, handleSelectFile, null, handleStage),
    // Untracked
    renderFileSection('Untracked', 'untracked', untracked, expandedSections, handleSelectFile, null, handleStage),
    // Stage all / Unstage all buttons
    (staged.length > 0 || unstaged.length > 0 || untracked.length > 0) && h('div', { className: 'px-3 py-1 flex gap-1 border-b border-ctp-surface0' },
      (unstaged.length > 0 || untracked.length > 0) && h('button', {
        className: 'text-[10px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext0 hover:text-ctp-text transition-colors',
        onClick: handleStageAll,
      }, 'Stage All'),
      staged.length > 0 && h('button', {
        className: 'text-[10px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext0 hover:text-ctp-text transition-colors',
        onClick: handleUnstageAll,
      }, 'Unstage All'),
    ),
    // Commit box
    staged.length > 0 && h('div', { className: 'px-3 py-2 border-b border-ctp-surface0' },
      h('textarea', {
        className: 'w-full bg-ctp-base text-ctp-text text-[11px] rounded p-1.5 border border-ctp-surface0 resize-none focus:outline-none focus:border-ctp-blue',
        rows: 3,
        placeholder: 'Commit message...',
        value: commitMessage,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => gitState.setCommitMessage(e.target.value),
        'data-testid': 'git-commit-message',
      }),
      h('button', {
        className: 'mt-1 w-full text-[11px] px-2 py-1 rounded bg-ctp-blue/20 text-ctp-blue hover:bg-ctp-blue/30 transition-colors disabled:opacity-40',
        onClick: handleCommit,
        disabled: !commitMessage.trim(),
        'data-testid': 'git-commit-btn',
      }, 'Commit'),
    ),
    // Branches section
    renderCollapseSection('Branches', 'branches', expandedSections, () =>
      h('div', { className: 'py-1' },
        gitInfo.branches.map((b) =>
          h('button', {
            key: b,
            className: `w-full text-left px-3 py-1 text-[11px] transition-colors ${
              b === gitInfo.branch ? 'text-ctp-text font-medium bg-surface-1' : 'text-ctp-subtext1 hover:bg-surface-0'
            }`,
            onClick: () => { if (b !== gitInfo.branch) handleCheckout(b); },
          }, b),
        ),
      ),
    ),
    // Stash section
    gitInfo.stashCount > 0 && renderCollapseSection(`Stash (${gitInfo.stashCount})`, 'stash', expandedSections, () =>
      h('div', { className: 'px-3 py-1 flex gap-1' },
        h('button', {
          className: 'text-[10px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext0 hover:text-ctp-text transition-colors',
          onClick: handleStash,
        }, 'Stash'),
        h('button', {
          className: 'text-[10px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext0 hover:text-ctp-text transition-colors',
          onClick: handleStashPop,
        }, 'Pop'),
      ),
    ),
    // Commit log section
    renderCollapseSection('History', 'log', expandedSections, () =>
      h('div', { className: 'py-1' },
        commitLog.map((entry) =>
          h('button', {
            key: entry.hash,
            className: `w-full text-left px-3 py-1.5 transition-colors ${
              gitState.selectedCommit === entry.hash ? 'bg-surface-1' : 'hover:bg-surface-0'
            }`,
            onClick: () => handleSelectCommit(entry.hash),
            'data-testid': `git-log-${entry.shortHash}`,
          },
            h('div', { className: 'text-[11px] text-ctp-text truncate' }, entry.subject),
            h('div', { className: 'text-[9px] text-ctp-overlay0 flex gap-2' },
              h('span', null, entry.shortHash),
              h('span', null, entry.author),
              h('span', null, entry.date),
            ),
          ),
        ),
      ),
    ),
  );
}

// ── Main Panel ───────────────────────────────────────────────────────

export function MainPanel({ api }: { api: PluginAPI }) {
  const { gitInfo, selectedFile, selectedCommit, selectedCommitFiles } = useGitState();
  const projectPath = api.context.projectPath || '';
  const [diffData, setDiffData] = useState<{ original: string; modified: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // Dynamic title
  useEffect(() => {
    if (selectedFile) {
      const name = selectedFile.split('/').pop() || selectedFile;
      api.window.setTitle(`Git — ${name}`);
    } else if (selectedCommit) {
      api.window.setTitle(`Git — ${selectedCommit.slice(0, 7)}`);
    } else {
      api.window.setTitle('Git');
    }
    return () => api.window.resetTitle();
  }, [api, selectedFile, selectedCommit]);

  // Fetch diff when file selected from working changes
  useEffect(() => {
    if (!selectedFile || !projectPath) {
      setDiffData(null);
      return;
    }
    setLoading(true);
    const file = gitInfo?.status.find((f) => f.path === selectedFile);
    const staged = file?.staged ?? false;
    window.clubhouse.git.diff(projectPath, selectedFile, staged)
      .then((data: { original: string; modified: string }) => { setDiffData(data); setLoading(false); })
      .catch(() => { setDiffData(null); setLoading(false); });
  }, [selectedFile, projectPath, gitInfo]);

  // Fetch diff when file selected from commit detail
  const [commitFilePath, setCommitFilePath] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedCommit || !commitFilePath || !projectPath) {
      if (selectedCommit && !commitFilePath) setDiffData(null);
      return;
    }
    setLoading(true);
    window.clubhouse.git.commitDiff(projectPath, selectedCommit, commitFilePath)
      .then((data: { original: string; modified: string }) => { setDiffData(data); setLoading(false); })
      .catch(() => { setDiffData(null); setLoading(false); });
  }, [selectedCommit, commitFilePath, projectPath]);

  // Reset commit file when commit changes
  useEffect(() => {
    setCommitFilePath(null);
    setDiffData(null);
  }, [selectedCommit]);

  // Commit detail view
  if (selectedCommit) {
    return h('div', { className: 'flex flex-col h-full bg-ctp-base', 'data-testid': 'git-main-panel' },
      h('div', { className: 'flex items-center gap-2 px-3 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0' },
        h('span', { className: 'text-xs font-medium text-ctp-text' }, `Commit ${selectedCommit.slice(0, 7)}`),
        h('span', { className: 'text-[9px] text-ctp-subtext0' }, `${selectedCommitFiles.length} files`),
      ),
      h('div', { className: 'flex flex-1 min-h-0' },
        h('div', { className: 'w-48 flex-shrink-0 overflow-y-auto border-r border-ctp-surface0 bg-ctp-mantle/30' },
          selectedCommitFiles.map((f) => {
            const info = statusInfo(f.status);
            const name = f.path.split('/').pop() || f.path;
            return h('button', {
              key: f.path,
              className: `w-full text-left px-2 py-1 text-[11px] transition-colors ${
                commitFilePath === f.path ? 'bg-ctp-surface1' : 'hover:bg-surface-0'
              }`,
              onClick: () => setCommitFilePath(f.path),
            },
              h('span', { className: `${info.color} mr-1` }, info.short),
              h('span', { className: 'truncate text-ctp-text' }, name),
            );
          }),
        ),
        h('div', { className: 'flex-1 min-w-0' },
          loading
            ? h('div', { className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs' }, 'Loading diff...')
            : diffData
              ? h(MonacoDiffEditorLazy, { original: diffData.original, modified: diffData.modified, filePath: commitFilePath || '' })
              : h('div', { className: 'flex items-center justify-center h-full text-ctp-overlay0 text-xs' }, 'Select a file to view diff'),
        ),
      ),
    );
  }

  // Working tree diff view
  return h('div', { className: 'flex flex-col h-full bg-ctp-base', 'data-testid': 'git-main-panel' },
    h('div', { className: 'flex items-center gap-2 px-3 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0' },
      h('span', { className: 'text-xs font-medium text-ctp-text' },
        selectedFile ? selectedFile.split('/').pop() || selectedFile : 'Git',
      ),
      selectedFile && h('span', { className: 'text-[9px] text-ctp-subtext0 truncate' }, selectedFile),
    ),
    h('div', { className: 'flex-1 min-h-0' },
      loading
        ? h('div', { className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs' }, 'Loading diff...')
        : diffData
          ? h(MonacoDiffEditorLazy, { original: diffData.original, modified: diffData.modified, filePath: selectedFile || '' })
          : h('div', { className: 'flex items-center justify-center h-full text-ctp-overlay0 text-xs' },
              selectedFile ? 'Loading...' : 'Select a file to view diff',
            ),
    ),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

const h = React.createElement;

/** Lazily imported MonacoDiffEditor — avoids pulling Monaco into the git plugin bundle at parse time. */
const MonacoDiffEditorLazy = React.lazy(
  () => import('../canvas/MonacoDiffEditor').then((m) => ({ default: m.MonacoDiffEditor })),
);

function renderFileSection(
  title: string,
  sectionKey: string,
  files: GitStatusFile[],
  expandedSections: Record<string, boolean>,
  onSelect: (path: string) => void,
  onSecondaryAction: ((path: string) => void) | null,
  onPrimaryAction: ((path: string) => void) | null,
) {
  if (files.length === 0) return null;
  const expanded = expandedSections[sectionKey] !== false;
  return h(React.Fragment, null,
    h('button', {
      className: 'w-full flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-ctp-surface0 hover:bg-surface-0',
      onClick: () => gitState.toggleSection(sectionKey),
    },
      h('span', { className: `transition-transform ${expanded ? 'rotate-90' : ''}` }, '▸'),
      `${title} (${files.length})`,
    ),
    expanded && h('div', { className: 'border-b border-ctp-surface0' },
      files.map((file) => {
        const info = statusInfo(file.status);
        const name = file.path.split('/').pop() || file.path;
        const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
        return h('div', {
          key: file.path,
          className: `flex items-center gap-1 px-3 py-1 cursor-pointer transition-colors ${
            gitState.selectedFile === file.path ? 'bg-ctp-surface1' : 'hover:bg-surface-0'
          }`,
          onClick: () => onSelect(file.path),
        },
          h('span', { className: `w-3 text-center text-[9px] font-bold flex-shrink-0 ${info.color}` }, info.short),
          h('div', { className: 'flex-1 min-w-0' },
            h('div', { className: 'text-[11px] text-ctp-text truncate' }, name),
            dir && h('div', { className: 'text-[8px] text-ctp-overlay0 truncate' }, dir),
          ),
          onSecondaryAction && h('button', {
            className: 'text-[9px] text-ctp-subtext0 hover:text-ctp-text px-1 flex-shrink-0',
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); onSecondaryAction(file.path); },
            title: 'Unstage',
          }, '−'),
          onPrimaryAction && h('button', {
            className: 'text-[9px] text-ctp-subtext0 hover:text-ctp-text px-1 flex-shrink-0',
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); onPrimaryAction(file.path); },
            title: 'Stage',
          }, '+'),
        );
      }),
    ),
  );
}

function renderCollapseSection(
  title: string,
  sectionKey: string,
  expandedSections: Record<string, boolean>,
  renderContent: () => React.ReactNode,
) {
  const expanded = expandedSections[sectionKey] !== false;
  return h(React.Fragment, null,
    h('button', {
      className: 'w-full flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-ctp-surface0 hover:bg-surface-0',
      onClick: () => gitState.toggleSection(sectionKey),
    },
      h('span', { className: `transition-transform ${expanded ? 'rotate-90' : ''}` }, '▸'),
      title,
    ),
    expanded && h('div', { className: 'border-b border-ctp-surface0' }, renderContent()),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
