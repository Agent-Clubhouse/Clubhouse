import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { FileNode } from '../../../../shared/types';
import { fileState } from './state';
import { getFileIconColor } from './file-icons';

// ── Icons ──────────────────────────────────────────────────────────────

const RefreshIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '23 4 23 10 17 10' }),
   React.createElement('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }));

const FolderIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'text-ctp-blue flex-shrink-0',
}, React.createElement('path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }));

const FolderOpenIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'text-ctp-blue flex-shrink-0',
}, React.createElement('path', { d: 'M5 19a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 3h9a2 2 0 0 1 2 2v1' }),
   React.createElement('path', { d: 'M22 10H10a2 2 0 0 0-2 2l-1 7h15l1-7a2 2 0 0 0-2-2z' }));

const FileIcon = (color: string) => React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: `${color} flex-shrink-0`,
}, React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
   React.createElement('polyline', { points: '14 2 14 8 20 8' }));

const ChevronRight = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'flex-shrink-0',
}, React.createElement('polyline', { points: '9 18 15 12 9 6' }));

const ChevronDown = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'flex-shrink-0',
}, React.createElement('polyline', { points: '6 9 12 15 18 9' }));

const NewFileIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
   React.createElement('polyline', { points: '14 2 14 8 20 8' }),
   React.createElement('line', { x1: 12, y1: 18, x2: 12, y2: 12 }),
   React.createElement('line', { x1: 9, y1: 15, x2: 15, y2: 15 }));

const NewFolderIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }),
   React.createElement('line', { x1: 12, y1: 11, x2: 12, y2: 17 }),
   React.createElement('line', { x1: 9, y1: 14, x2: 15, y2: 14 }));

const ExpandAllIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '6 6 12 12 18 6' }),
   React.createElement('polyline', { points: '6 12 12 18 18 12' }));

const CollapseAllIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('polyline', { points: '6 18 12 12 18 18' }),
   React.createElement('polyline', { points: '6 12 12 6 18 12' }));

const GitBranchIcon = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('line', { x1: 6, y1: 3, x2: 6, y2: 15 }),
   React.createElement('circle', { cx: 18, cy: 6, r: 3 }),
   React.createElement('circle', { cx: 6, cy: 18, r: 3 }),
   React.createElement('path', { d: 'M18 9a9 9 0 0 1-9 9' }));

// ── Git status badge ───────────────────────────────────────────────────

function GitBadge({ status }: { status: string }) {
  let color = 'text-ctp-subtext0';
  let letter = status.charAt(0).toUpperCase();

  switch (letter) {
    case 'M': color = 'text-ctp-yellow'; break;
    case '?': letter = 'U'; color = 'text-ctp-green'; break;
    case 'A': color = 'text-ctp-green'; break;
    case 'D': color = 'text-ctp-red'; break;
    case 'R': color = 'text-ctp-blue'; break;
  }

  return React.createElement('span', {
    className: `text-[10px] font-bold ${color} ml-auto flex-shrink-0 pl-1`,
  }, letter);
}

// ── Helpers ────────────────────────────────────────────────────────────

function getRelativePath(fullPath: string, projectPath: string): string {
  if (fullPath.startsWith(projectPath)) {
    const rel = fullPath.slice(projectPath.length);
    return rel.startsWith('/') ? rel.slice(1) : rel;
  }
  return fullPath;
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function collectAllDirPaths(nodes: FileNode[]): Set<string> {
  const dirs = new Set<string>();
  const walk = (items: FileNode[]) => {
    for (const n of items) {
      if (n.isDirectory) {
        dirs.add(n.path);
        if (n.children) walk(n.children);
      }
    }
  };
  walk(nodes);
  return dirs;
}

// ── Tree Node ─────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selected: string | null;
  focused: string | null;
  gitMap: Map<string, string>;
  projectPath: string;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

function TreeNode({ node, depth, expanded, onToggle, onSelect, selected, focused, gitMap, projectPath, onContextMenu }: TreeNodeProps) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selected === node.path;
  const isFocused = focused === node.path;
  const ext = getExtension(node.name);
  const relPath = getRelativePath(node.path, projectPath);
  const gitStatus = gitMap.get(relPath);

  const bgClass = isSelected ? 'bg-ctp-surface1' : isFocused ? 'bg-ctp-surface0' : 'hover:bg-ctp-surface0';

  const handleClick = () => {
    if (node.isDirectory) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  const icon = node.isDirectory
    ? (isExpanded ? FolderOpenIcon : FolderIcon)
    : FileIcon(getFileIconColor(ext));

  const chevron = node.isDirectory
    ? (isExpanded ? ChevronDown : ChevronRight)
    : React.createElement('span', { className: 'w-3' });

  const elements: React.ReactNode[] = [
    React.createElement('div', {
      key: node.path,
      className: `flex items-center gap-1 px-2 py-0.5 cursor-pointer select-none text-xs ${bgClass} transition-colors`,
      style: { paddingLeft: `${8 + depth * 12}px` },
      onClick: handleClick,
      onContextMenu: (e: React.MouseEvent) => onContextMenu(e, node),
      'data-path': node.path,
    },
      chevron,
      icon,
      React.createElement('span', {
        className: 'truncate text-ctp-text',
      }, node.name),
      gitStatus ? React.createElement(GitBadge, { status: gitStatus }) : null,
    ),
  ];

  // Render children if expanded
  if (node.isDirectory && isExpanded && node.children) {
    for (const child of node.children) {
      elements.push(
        React.createElement(TreeNode, {
          key: child.path,
          node: child,
          depth: depth + 1,
          expanded,
          onToggle,
          onSelect,
          selected,
          focused,
          gitMap,
          projectPath,
          onContextMenu,
        }),
      );
    }
  }

  return React.createElement(React.Fragment, null, ...elements);
}

// ── Context menu ──────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  node: FileNode;
  onClose: () => void;
  onAction: (action: string) => void;
}

function ContextMenu({ x, y, node: _node, onClose, onAction }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const items = [
    { label: 'New File', action: 'newFile' },
    { label: 'New Folder', action: 'newFolder' },
    { label: 'Rename', action: 'rename' },
    { label: 'Copy', action: 'copy' },
    { label: 'Delete', action: 'delete' },
  ];

  return React.createElement('div', {
    ref: menuRef,
    className: 'fixed z-50 bg-ctp-mantle border border-ctp-surface0 rounded shadow-lg py-1 min-w-[140px]',
    style: { left: x, top: y },
  },
    ...items.map((item) =>
      React.createElement('button', {
        key: item.action,
        className: `w-full text-left px-3 py-1 text-xs text-ctp-text hover:bg-ctp-surface0 transition-colors ${item.action === 'delete' ? 'text-ctp-red' : ''}`,
        onClick: () => { onAction(item.action); onClose(); },
      }, item.label),
    ),
  );
}

// ── FileTree (SidebarPanel) ───────────────────────────────────────────

export function FileTree({ api }: { api: PluginAPI }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [gitMap, setGitMap] = useState<Map<string, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  const [rootPath, setRootPath] = useState<string>('.');
  const [worktrees, setWorktrees] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>('');
  const containerRef = useRef<HTMLDivElement>(null);
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const projectPath = api.context.projectPath || '';
  const showHidden = api.settings.get<boolean>('showHiddenFiles') ?? true;

  // Collect all visible nodes for keyboard navigation
  const getVisibleNodes = useCallback((): FileNode[] => {
    const result: FileNode[] = [];
    const collect = (nodes: FileNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.isDirectory && expanded.has(node.path) && node.children) {
          collect(node.children);
        }
      }
    };
    collect(tree);
    return result;
  }, [tree, expanded]);

  // Load tree from API
  const loadTree = useCallback(async () => {
    try {
      const nodes = await api.files.readTree(rootPath, { includeHidden: showHidden, depth: 1 });
      setTree(nodes);
    } catch {
      setTree([]);
    }
  }, [api, showHidden, rootPath]);

  // Load git status
  const loadGitStatus = useCallback(async () => {
    try {
      const statuses = await api.git.status();
      const map = new Map<string, string>();
      for (const s of statuses) {
        map.set(s.path, s.status);
      }
      setGitMap(map);
    } catch {
      setGitMap(new Map());
    }
  }, [api]);

  // Load current branch
  const loadBranch = useCallback(async () => {
    try {
      const branch = await api.git.currentBranch();
      setCurrentBranch(branch);
    } catch {
      setCurrentBranch('');
    }
  }, [api]);

  // Load worktree list
  const loadWorktrees = useCallback(async () => {
    try {
      const entries = await api.files.readTree('.clubhouse/agents', { depth: 1 });
      setWorktrees(entries.filter((e) => e.isDirectory).map((e) => e.name));
    } catch {
      setWorktrees([]);
    }
  }, [api]);

  // Restore persisted state on mount
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const [savedPath, savedRoot] = await Promise.all([
          api.storage.project.read('files:lastSelectedPath'),
          api.storage.project.read('files:lastRootPath'),
        ]);
        if (cancelled) return;
        if (typeof savedRoot === 'string' && savedRoot) {
          setRootPath(savedRoot);
        }
        if (typeof savedPath === 'string' && savedPath) {
          setSelectedPath(`${projectPath}/${savedPath}`);
          fileState.setSelectedPath(savedPath);
        }
      } catch {
        // Fresh start
      }
    }
    restore();
    return () => { cancelled = true; };
  }, [api, projectPath]);

  // Initial load
  useEffect(() => {
    loadTree();
    loadGitStatus();
    loadBranch();
    loadWorktrees();
  }, [loadTree, loadGitStatus, loadBranch, loadWorktrees]);

  // Subscribe to fileState refresh signals
  const lastRefreshRef = useRef(fileState.refreshCount);
  useEffect(() => {
    return fileState.subscribe(() => {
      // Sync selected path — convert relative to absolute for tree highlighting
      const relPath = fileState.selectedPath;
      setSelectedPath(relPath ? `${projectPath}/${relPath}` : null);

      // Only reload tree when an explicit refresh was triggered
      if (fileState.refreshCount !== lastRefreshRef.current) {
        lastRefreshRef.current = fileState.refreshCount;
        loadTree();
        loadGitStatus();
        loadBranch();
      }
    });
  }, [loadTree, loadGitStatus, loadBranch, projectPath]);

  // Subscribe to settings changes
  useEffect(() => {
    const disposable = api.settings.onChange((key) => {
      if (key === 'showHiddenFiles') {
        loadTree();
      }
    });
    return () => disposable.dispose();
  }, [api, loadTree]);

  // File watching — auto-refresh tree on external changes
  useEffect(() => {
    const disposable = api.files.watch('**/*', () => {
      if (watchDebounceRef.current) clearTimeout(watchDebounceRef.current);
      watchDebounceRef.current = setTimeout(() => {
        loadTree();
        loadGitStatus();
        loadBranch();
      }, 500);
    });
    return () => {
      if (watchDebounceRef.current) clearTimeout(watchDebounceRef.current);
      disposable.dispose();
    };
  }, [api, loadTree, loadGitStatus, loadBranch]);

  // Expand directory — lazy load children
  const toggleExpand = useCallback(async (dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });

    // Lazy load children if not yet loaded
    const relPath = getRelativePath(dirPath, projectPath);
    try {
      const children = await api.files.readTree(relPath, { includeHidden: showHidden, depth: 1 });
      setTree((prevTree) => {
        const updateNode = (nodes: FileNode[]): FileNode[] => {
          return nodes.map((n) => {
            if (n.path === dirPath) {
              return { ...n, children };
            }
            if (n.isDirectory && n.children) {
              return { ...n, children: updateNode(n.children) };
            }
            return n;
          });
        };
        return updateNode(prevTree);
      });
    } catch {
      // ignore
    }
  }, [api, projectPath, showHidden]);

  // Select file
  const selectFile = useCallback((path: string) => {
    setSelectedPath(path);
    const relPath = getRelativePath(path, projectPath);
    fileState.setSelectedPath(relPath);
    api.storage.project.write('files:lastSelectedPath', relPath).catch(() => {});
  }, [projectPath, api]);

  // Handle root path change (worktree selector)
  const handleRootChange = useCallback((newRoot: string) => {
    setRootPath(newRoot);
    setExpanded(new Set());
    setSelectedPath(null);
    setFocusedPath(null);
    fileState.setSelectedPath(null);
    api.storage.project.write('files:lastRootPath', newRoot).catch(() => {});
    api.storage.project.write('files:lastSelectedPath', '').catch(() => {});
  }, [api]);

  // Expand all directories
  const expandAll = useCallback(async () => {
    try {
      const fullTree = await api.files.readTree(rootPath, { includeHidden: showHidden, depth: 10 });
      setTree(fullTree);
      setExpanded(collectAllDirPaths(fullTree));
    } catch {
      // ignore
    }
  }, [api, rootPath, showHidden]);

  // Collapse all directories
  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  // New file at root or selected directory
  const handleNewFile = useCallback(async () => {
    const name = await api.ui.showInput('File name');
    if (!name) return;

    let dir = rootPath === '.' ? '' : rootPath;
    if (selectedPath) {
      const relSelected = getRelativePath(selectedPath, projectPath);
      // Check if the tree node at selectedPath is a directory
      const findNode = (nodes: FileNode[]): FileNode | undefined => {
        for (const n of nodes) {
          if (n.path === selectedPath) return n;
          if (n.children) {
            const found = findNode(n.children);
            if (found) return found;
          }
        }
        return undefined;
      };
      const node = findNode(tree);
      if (node?.isDirectory) {
        dir = relSelected;
      } else {
        dir = relSelected.replace(/\/[^/]+$/, '') || (rootPath === '.' ? '' : rootPath);
      }
    }

    const newPath = dir ? `${dir}/${name}` : name;
    try {
      await api.files.writeFile(newPath, '');
      loadTree();
      loadGitStatus();
    } catch (err) {
      api.ui.showError(`Failed to create file: ${err}`);
    }
  }, [api, rootPath, selectedPath, projectPath, tree, loadTree, loadGitStatus]);

  // New folder at root or selected directory
  const handleNewFolder = useCallback(async () => {
    const name = await api.ui.showInput('Folder name');
    if (!name) return;

    let dir = rootPath === '.' ? '' : rootPath;
    if (selectedPath) {
      const relSelected = getRelativePath(selectedPath, projectPath);
      const findNode = (nodes: FileNode[]): FileNode | undefined => {
        for (const n of nodes) {
          if (n.path === selectedPath) return n;
          if (n.children) {
            const found = findNode(n.children);
            if (found) return found;
          }
        }
        return undefined;
      };
      const node = findNode(tree);
      if (node?.isDirectory) {
        dir = relSelected;
      } else {
        dir = relSelected.replace(/\/[^/]+$/, '') || (rootPath === '.' ? '' : rootPath);
      }
    }

    const newPath = dir ? `${dir}/${name}` : name;
    try {
      await api.files.mkdir(newPath);
      loadTree();
      loadGitStatus();
    } catch (err) {
      api.ui.showError(`Failed to create folder: ${err}`);
    }
  }, [api, rootPath, selectedPath, projectPath, tree, loadTree, loadGitStatus]);

  // File operations (context menu)
  const handleContextAction = useCallback(async (action: string, node: FileNode) => {
    const parentDir = node.isDirectory
      ? getRelativePath(node.path, projectPath)
      : getRelativePath(node.path, projectPath).replace(/\/[^/]+$/, '') || '.';

    switch (action) {
      case 'newFile': {
        const name = await api.ui.showInput('File name');
        if (!name) return;
        const newPath = parentDir === '.' ? name : `${node.isDirectory ? getRelativePath(node.path, projectPath) : parentDir}/${name}`;
        await api.files.writeFile(newPath, '');
        break;
      }
      case 'newFolder': {
        const name = await api.ui.showInput('Folder name');
        if (!name) return;
        const newPath = parentDir === '.' ? name : `${node.isDirectory ? getRelativePath(node.path, projectPath) : parentDir}/${name}`;
        await api.files.mkdir(newPath);
        break;
      }
      case 'rename': {
        const newName = await api.ui.showInput('New name', node.name);
        if (!newName || newName === node.name) return;
        const oldRel = getRelativePath(node.path, projectPath);
        const newRel = oldRel.replace(/[^/]+$/, newName);
        await api.files.rename(oldRel, newRel);
        break;
      }
      case 'copy': {
        const copyName = await api.ui.showInput('Copy name', node.name + ' copy');
        if (!copyName) return;
        const srcRel = getRelativePath(node.path, projectPath);
        const destRel = srcRel.replace(/[^/]+$/, copyName);
        await api.files.copy(srcRel, destRel);
        break;
      }
      case 'delete': {
        const confirmed = await api.ui.showConfirm(`Delete "${node.name}"? This cannot be undone.`);
        if (!confirmed) return;
        await api.files.delete(getRelativePath(node.path, projectPath));
        break;
      }
    }

    // Refresh tree after operation
    loadTree();
    loadGitStatus();
  }, [api, projectPath, loadTree, loadGitStatus]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const visible = getVisibleNodes();
    if (visible.length === 0) return;

    const currentIndex = visible.findIndex((n) => n.path === focusedPath);

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const nextIndex = currentIndex < visible.length - 1 ? currentIndex + 1 : 0;
        setFocusedPath(visible[nextIndex].path);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : visible.length - 1;
        setFocusedPath(visible[prevIndex].path);
        break;
      }
      case 'Enter': {
        e.preventDefault();
        if (focusedPath) {
          const node = visible.find((n) => n.path === focusedPath);
          if (node) {
            if (node.isDirectory) {
              toggleExpand(node.path);
            } else {
              selectFile(node.path);
            }
          }
        }
        break;
      }
      case 'Delete':
      case 'Backspace': {
        e.preventDefault();
        if (focusedPath) {
          const node = visible.find((n) => n.path === focusedPath);
          if (node) {
            handleContextAction('delete', node);
          }
        }
        break;
      }
    }
  }, [focusedPath, getVisibleNodes, toggleExpand, selectFile, handleContextAction]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  return React.createElement('div', {
    ref: containerRef,
    className: 'flex flex-col h-full bg-ctp-mantle text-ctp-text select-none',
    tabIndex: 0,
    onKeyDown: handleKeyDown,
  },
    // Header
    React.createElement('div', {
      className: 'flex flex-col border-b border-ctp-surface0 flex-shrink-0',
    },
      // Row 1: Branch + Worktree selector
      React.createElement('div', {
        className: 'flex items-center gap-2 px-3 py-1',
      },
        // Branch indicator
        currentBranch
          ? React.createElement('div', {
              className: 'flex items-center gap-1 text-[10px] text-ctp-subtext0 flex-shrink-0',
              title: `Branch: ${currentBranch}`,
            },
              GitBranchIcon,
              React.createElement('span', { className: 'truncate max-w-[80px]' }, currentBranch),
            )
          : null,

        // Worktree selector
        worktrees.length > 0
          ? React.createElement('select', {
              className: 'flex-1 min-w-0 text-[10px] bg-ctp-surface0 text-ctp-text border-none rounded px-1 py-0.5 cursor-pointer truncate outline-none',
              value: rootPath,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => handleRootChange(e.target.value),
              title: 'Switch worktree root',
            },
              React.createElement('option', { value: '.' }, '/ (root)'),
              ...worktrees.map((wt) =>
                React.createElement('option', {
                  key: wt,
                  value: `.clubhouse/agents/${wt}`,
                }, wt),
              ),
            )
          : React.createElement('span', { className: 'flex-1 text-xs font-medium' }, 'Files'),
      ),

      // Row 2: Toolbar buttons
      React.createElement('div', {
        className: 'flex items-center justify-end gap-0.5 px-2 pb-1',
      },
        // New File
        React.createElement('button', {
          className: 'p-0.5 text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: handleNewFile,
          title: 'New File',
        }, NewFileIcon),
        // New Folder
        React.createElement('button', {
          className: 'p-0.5 text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: handleNewFolder,
          title: 'New Folder',
        }, NewFolderIcon),
        // Separator
        React.createElement('div', { className: 'w-px h-3 bg-ctp-surface0 mx-0.5' }),
        // Expand All
        React.createElement('button', {
          className: 'p-0.5 text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: expandAll,
          title: 'Expand All',
        }, ExpandAllIcon),
        // Collapse All
        React.createElement('button', {
          className: 'p-0.5 text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: collapseAll,
          title: 'Collapse All',
        }, CollapseAllIcon),
        // Separator
        React.createElement('div', { className: 'w-px h-3 bg-ctp-surface0 mx-0.5' }),
        // Refresh
        React.createElement('button', {
          className: 'p-0.5 text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: () => { loadTree(); loadGitStatus(); loadBranch(); },
          title: 'Refresh',
        }, RefreshIcon),
      ),
    ),

    // Tree
    React.createElement('div', { className: 'flex-1 overflow-auto py-1' },
      tree.length === 0
        ? React.createElement('div', { className: 'px-3 py-4 text-xs text-ctp-subtext0 text-center' }, 'No files found')
        : tree.map((node) =>
            React.createElement(TreeNode, {
              key: node.path,
              node,
              depth: 0,
              expanded,
              onToggle: toggleExpand,
              onSelect: selectFile,
              selected: selectedPath,
              focused: focusedPath,
              gitMap,
              projectPath,
              onContextMenu: handleContextMenu,
            }),
          ),
    ),

    // Context menu
    contextMenu
      ? React.createElement(ContextMenu, {
          x: contextMenu.x,
          y: contextMenu.y,
          node: contextMenu.node,
          onClose: () => setContextMenu(null),
          onAction: (action: string) => handleContextAction(action, contextMenu.node),
        })
      : null,
  );
}
