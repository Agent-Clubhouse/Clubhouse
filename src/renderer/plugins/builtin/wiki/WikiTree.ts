import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginAPI, FilesAPI } from '../../../../shared/plugin-types';
import type { FileNode } from '../../../../shared/types';
import { wikiState } from './state';
import { getFileIconColor } from '../files/file-icons';

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

const AgentIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('circle', { cx: 12, cy: 12, r: 10 }),
   React.createElement('path', { d: 'M12 16v-4' }),
   React.createElement('path', { d: 'M12 8h.01' }));

// ── Helpers ────────────────────────────────────────────────────────────

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function prettifyName(name: string): string {
  // Strip .md extension, replace dashes/underscores with spaces, title-case
  const base = name.replace(/\.md$/i, '');
  return base
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function filterMarkdownTree(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.isDirectory) {
      const filteredChildren = node.children ? filterMarkdownTree(node.children) : [];
      // Only include directories that have markdown files (directly or in sub-dirs)
      if (filteredChildren.length > 0) {
        result.push({ ...node, children: filteredChildren });
      }
    } else if (getExtension(node.name) === 'md') {
      result.push(node);
    }
  }
  return result;
}

// ── Context menu ──────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  node: FileNode;
  onClose: () => void;
  onAction: (action: string) => void;
}

function ContextMenu({ x, y, node, onClose, onAction }: ContextMenuProps) {
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

// ── Tree Node ─────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selected: string | null;
  focused: string | null;
  viewMode: 'view' | 'edit';
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

function TreeNode({ node, depth, expanded, onToggle, onSelect, selected, focused, viewMode, onContextMenu }: TreeNodeProps) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selected === node.path;
  const isFocused = focused === node.path;
  const ext = getExtension(node.name);

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

  const displayName = viewMode === 'view' && !node.isDirectory
    ? prettifyName(node.name)
    : node.name;

  const elements: React.ReactNode[] = [
    React.createElement('div', {
      key: node.path,
      className: `flex items-center gap-1 px-2 py-0.5 cursor-pointer select-none text-xs ${bgClass} transition-colors`,
      style: { paddingLeft: `${8 + depth * 12}px` },
      onClick: handleClick,
      onContextMenu: viewMode === 'edit' ? (e: React.MouseEvent) => onContextMenu(e, node) : undefined,
      'data-path': node.path,
    },
      chevron,
      icon,
      React.createElement('span', {
        className: 'truncate text-ctp-text',
      }, displayName),
    ),
  ];

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
          viewMode,
          onContextMenu,
        }),
      );
    }
  }

  return React.createElement(React.Fragment, null, ...elements);
}

// ── WikiTree (SidebarPanel) ───────────────────────────────────────────

export function WikiTree({ api }: { api: PluginAPI }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'view' | 'edit'>(wikiState.viewMode);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wikiFilesRef = useRef<FilesAPI | null>(null);

  const showHidden = api.settings.get<boolean>('showHiddenFiles') || false;

  // Obtain scoped files API for 'wiki' root
  const getScopedFiles = useCallback((): FilesAPI | null => {
    try {
      const scoped = api.files.forRoot('wiki');
      wikiFilesRef.current = scoped;
      setConfigError(null);
      return scoped;
    } catch {
      setConfigError('Wiki path not configured. Open Settings to set the wiki directory path.');
      wikiFilesRef.current = null;
      return null;
    }
  }, [api]);

  // Load tree
  const loadTree = useCallback(async () => {
    const scoped = getScopedFiles();
    if (!scoped) {
      setTree([]);
      return;
    }
    try {
      const nodes = await scoped.readTree('.', { includeHidden: showHidden, depth: 1 });
      setTree(nodes);
    } catch {
      setTree([]);
    }
  }, [getScopedFiles, showHidden]);

  // Initial load
  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // Subscribe to wikiState refresh + selection signals
  const lastRefreshRef = useRef(wikiState.refreshCount);
  useEffect(() => {
    return wikiState.subscribe(() => {
      setSelectedPath(wikiState.selectedPath);
      setViewMode(wikiState.viewMode);

      if (wikiState.refreshCount !== lastRefreshRef.current) {
        lastRefreshRef.current = wikiState.refreshCount;
        loadTree();
      }
    });
  }, [loadTree]);

  // Re-obtain scoped API on wikiPath setting change
  useEffect(() => {
    const disposable = api.settings.onChange((key) => {
      if (key === 'wikiPath' || key === 'showHiddenFiles') {
        loadTree();
      }
    });
    return () => disposable.dispose();
  }, [api, loadTree]);

  // Collect visible nodes for keyboard nav
  const getVisibleNodes = useCallback((): FileNode[] => {
    const displayTree = viewMode === 'view' ? filterMarkdownTree(tree) : tree;
    const result: FileNode[] = [];
    const collect = (nodes: FileNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.isDirectory && expanded.has(node.path) && node.children) {
          collect(viewMode === 'view' ? filterMarkdownTree(node.children) : node.children);
        }
      }
    };
    collect(displayTree);
    return result;
  }, [tree, expanded, viewMode]);

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

    const scoped = wikiFilesRef.current;
    if (!scoped) return;

    // Find relative path from the node's path
    try {
      const nodes = await scoped.readTree(dirPath, { includeHidden: showHidden, depth: 1 });
      setTree((prevTree) => {
        const updateNode = (items: FileNode[]): FileNode[] => {
          return items.map((n) => {
            if (n.path === dirPath) {
              return { ...n, children: nodes };
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
  }, [showHidden]);

  // Select file
  const selectFile = useCallback((path: string) => {
    setSelectedPath(path);
    wikiState.setSelectedPath(path);
  }, []);

  // View/Edit mode toggle
  const handleToggleMode = useCallback((mode: 'view' | 'edit') => {
    setViewMode(mode);
    wikiState.setViewMode(mode);
  }, []);

  // Run agent in wiki
  const handleRunAgent = useCallback(async () => {
    const wikiPath = api.settings.get<string>('wikiPath') || '';
    const mission = await api.ui.showInput('Mission');
    if (!mission) return;

    try {
      await api.agents.runQuick(mission, {
        systemPrompt: `You are working in the wiki directory at ${wikiPath}. This is a markdown wiki. Help the user with their request about the wiki content.`,
      });
      api.ui.showNotice('Agent launched in wiki context');
    } catch {
      api.ui.showError('Failed to launch agent');
    }
  }, [api]);

  // File operations (edit mode only)
  const handleContextAction = useCallback(async (action: string, node: FileNode) => {
    const scoped = wikiFilesRef.current;
    if (!scoped) return;

    const parentDir = node.isDirectory
      ? node.path
      : node.path.replace(/\/[^/]+$/, '') || '.';

    switch (action) {
      case 'newFile': {
        const name = await api.ui.showInput('File name');
        if (!name) return;
        const newPath = parentDir === '.' ? name : `${node.isDirectory ? node.path : parentDir}/${name}`;
        await scoped.writeFile(newPath, '');
        break;
      }
      case 'newFolder': {
        const name = await api.ui.showInput('Folder name');
        if (!name) return;
        const newPath = parentDir === '.' ? name : `${node.isDirectory ? node.path : parentDir}/${name}`;
        await scoped.mkdir(newPath);
        break;
      }
      case 'rename': {
        const newName = await api.ui.showInput('New name', node.name);
        if (!newName || newName === node.name) return;
        const newPath = node.path.replace(/[^/]+$/, newName);
        await scoped.rename(node.path, newPath);
        break;
      }
      case 'copy': {
        const copyName = await api.ui.showInput('Copy name', node.name + ' copy');
        if (!copyName) return;
        const destPath = node.path.replace(/[^/]+$/, copyName);
        await scoped.copy(node.path, destPath);
        break;
      }
      case 'delete': {
        const confirmed = await api.ui.showConfirm(`Delete "${node.name}"? This cannot be undone.`);
        if (!confirmed) return;
        await scoped.delete(node.path);
        break;
      }
    }

    loadTree();
  }, [api, loadTree]);

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
        if (viewMode !== 'edit') break;
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
  }, [focusedPath, getVisibleNodes, toggleExpand, selectFile, viewMode, handleContextAction]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  // Display tree based on mode
  const displayTree = viewMode === 'view' ? filterMarkdownTree(tree) : tree;

  // Error state
  if (configError) {
    return React.createElement('div', {
      className: 'flex flex-col h-full bg-ctp-mantle text-ctp-text',
    },
      React.createElement('div', {
        className: 'flex items-center justify-between px-3 py-1.5 border-b border-ctp-surface0 flex-shrink-0',
      },
        React.createElement('span', { className: 'text-xs font-medium' }, 'Wiki'),
      ),
      React.createElement('div', {
        className: 'px-3 py-4 text-xs text-ctp-subtext0 text-center',
      },
        React.createElement('div', { className: 'mb-2 text-ctp-peach' }, 'Wiki not configured'),
        React.createElement('div', null, configError),
      ),
    );
  }

  return React.createElement('div', {
    ref: containerRef,
    className: 'flex flex-col h-full bg-ctp-mantle text-ctp-text select-none',
    tabIndex: 0,
    onKeyDown: handleKeyDown,
  },
    // Header
    React.createElement('div', {
      className: 'flex items-center justify-between px-3 py-1.5 border-b border-ctp-surface0 flex-shrink-0',
    },
      React.createElement('span', { className: 'text-xs font-medium' }, 'Wiki'),
      React.createElement('div', { className: 'flex items-center gap-1' },
        React.createElement('button', {
          className: 'p-0.5 text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors',
          onClick: () => loadTree(),
          title: 'Refresh',
        }, RefreshIcon),
      ),
    ),

    // View/Edit toggle
    React.createElement('div', {
      className: 'px-3 py-1.5 border-b border-ctp-surface0 flex items-center gap-2',
    },
      React.createElement('div', { className: 'flex items-center bg-ctp-surface0 rounded text-[10px]' },
        React.createElement('button', {
          className: `px-2 py-0.5 rounded ${viewMode === 'view' ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-subtext0'}`,
          onClick: () => handleToggleMode('view'),
        }, 'View'),
        React.createElement('button', {
          className: `px-2 py-0.5 rounded ${viewMode === 'edit' ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-subtext0'}`,
          onClick: () => handleToggleMode('edit'),
        }, 'Edit'),
      ),
      React.createElement('button', {
        className: 'ml-auto px-2 py-0.5 text-[10px] text-ctp-accent hover:bg-ctp-accent/10 rounded transition-colors flex items-center gap-1',
        onClick: handleRunAgent,
        title: 'Run Agent in Wiki',
      }, AgentIcon, ' Agent'),
    ),

    // Tree
    React.createElement('div', { className: 'flex-1 overflow-auto py-1' },
      displayTree.length === 0
        ? React.createElement('div', { className: 'px-3 py-4 text-xs text-ctp-subtext0 text-center' },
            viewMode === 'view' ? 'No markdown files found' : 'No files found',
          )
        : displayTree.map((node) =>
            React.createElement(TreeNode, {
              key: node.path,
              node,
              depth: 0,
              expanded,
              onToggle: toggleExpand,
              onSelect: selectFile,
              selected: selectedPath,
              focused: focusedPath,
              viewMode,
              onContextMenu: handleContextMenu,
            }),
          ),
    ),

    // Context menu (edit mode only)
    contextMenu && viewMode === 'edit'
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
