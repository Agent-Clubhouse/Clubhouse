import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { FileNode } from '../../../../shared/types';
import { fileState } from './state';
import { getFileIconColor } from './file-icons';
import { fuzzyMatch } from '../../../features/command-palette/fuzzy-match';
import { PopupMenu, type MenuEntry, type MenuItem } from '../../../components/PopupMenu';
import { useFilesScope } from './filesScope';

// ── Icons ──────────────────────────────────────────────────────────────

const FolderIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'text-ctp-overlay1 flex-shrink-0',
}, React.createElement('path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }));

const FolderOpenIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'text-ctp-overlay1 flex-shrink-0',
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
  className: 'flex-shrink-0 text-ctp-overlay0',
}, React.createElement('polyline', { points: '9 18 15 12 9 6' }));

const ChevronDown = React.createElement('svg', {
  width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'flex-shrink-0 text-ctp-overlay0',
}, React.createElement('polyline', { points: '6 9 12 15 18 9' }));

const NewFileIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
   React.createElement('polyline', { points: '14 2 14 8 20 8' }),
   React.createElement('line', { x1: 12, y1: 18, x2: 12, y2: 12 }),
   React.createElement('line', { x1: 9, y1: 15, x2: 15, y2: 15 }));

const SearchIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}, React.createElement('circle', { cx: 11, cy: 11, r: 8 }),
   React.createElement('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }));

const MoreIcon = React.createElement('svg', {
  width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor',
}, React.createElement('circle', { cx: 5, cy: 12, r: 1.6 }),
   React.createElement('circle', { cx: 12, cy: 12, r: 1.6 }),
   React.createElement('circle', { cx: 19, cy: 12, r: 1.6 }));

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
    case 'M': color = 'text-ctp-warning'; break;
    case '?': letter = 'U'; color = 'text-ctp-success'; break;
    case 'A': color = 'text-ctp-success'; break;
    case 'D': color = 'text-ctp-error'; break;
    case 'R': color = 'text-ctp-info'; break;
  }

  return React.createElement('span', {
    className: `font-mono text-[11px] font-semibold ${color} ml-auto flex-shrink-0 pl-1`,
  }, letter);
}

// ── Helpers ────────────────────────────────────────────────────────────

function getRelativePath(fullPath: string, projectPath: string): string {
  if (fullPath.startsWith(projectPath)) {
    const rel = fullPath.slice(projectPath.length);
    return rel.replace(/^[\\/]+/, '');
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

/** Merge a new shallow tree with the old tree, preserving lazily-loaded children */
function mergeTreePreservingChildren(oldNodes: FileNode[], newNodes: FileNode[]): FileNode[] {
  const oldMap = new Map<string, FileNode>();
  for (const n of oldNodes) {
    oldMap.set(n.path, n);
  }

  return newNodes.map(newNode => {
    const oldNode = oldMap.get(newNode.path);
    if (!oldNode || !newNode.isDirectory || !oldNode.isDirectory) {
      return newNode;
    }
    if (oldNode.children && !newNode.children) {
      // Shallow load lost children — preserve old lazily-loaded children
      return { ...newNode, children: oldNode.children };
    }
    if (oldNode.children && newNode.children) {
      // Both have children — recursively merge
      return { ...newNode, children: mergeTreePreservingChildren(oldNode.children, newNode.children) };
    }
    return newNode;
  });
}

/** Update children of a specific directory node in the tree */
function updateNodeChildren(nodes: FileNode[], dirPath: string, children: FileNode[]): FileNode[] {
  return nodes.map(n => {
    if (n.path === dirPath) {
      return { ...n, children };
    }
    if (n.isDirectory && n.children) {
      return { ...n, children: updateNodeChildren(n.children, dirPath, children) };
    }
    return n;
  });
}

/**
 * Filter the loaded tree nodes by a fuzzy query string.
 * Returns matched file nodes (and ancestor directories) plus:
 *   - matchInfos: map from node.path → matched char indices *within node.name*
 *   - autoExpand: set of directory paths that must be expanded to show matches
 */
function filterTreeNodes(
  nodes: FileNode[],
  query: string,
  projectPath: string,
): {
  filteredNodes: FileNode[];
  matchInfos: Map<string, number[]>;
  autoExpand: Set<string>;
} {
  const matchInfos = new Map<string, number[]>();
  const autoExpand = new Set<string>();

  function walk(items: FileNode[]): FileNode[] {
    const results: FileNode[] = [];
    for (const node of items) {
      if (node.isDirectory) {
        const filteredChildren = walk(node.children ?? []);
        if (filteredChildren.length > 0) {
          autoExpand.add(node.path);
          results.push({ ...node, children: filteredChildren });
        }
      } else {
        const relPath = getRelativePath(node.path, projectPath);
        const result = fuzzyMatch(query, relPath);
        if (result) {
          // Map match indices from relPath into node.name
          const nameStart = relPath.lastIndexOf('/') + 1;
          const nameIndices = result.matches
            .filter(i => i >= nameStart)
            .map(i => i - nameStart);
          matchInfos.set(node.path, nameIndices);
          results.push(node);
        }
      }
    }
    return results;
  }

  return { filteredNodes: walk(nodes), matchInfos, autoExpand };
}

// ── HighlightedName ───────────────────────────────────────────────────

/** Renders a filename with matched characters bolded/coloured. */
function HighlightedName({ name, matches }: { name: string; matches: number[] }) {
  if (!matches.length) {
    return React.createElement('span', { className: 'truncate' }, name);
  }

  const matchSet = new Set(matches);
  const parts: React.ReactNode[] = [];
  let buf = '';
  let inMatch = false;
  let keyIdx = 0;

  for (let i = 0; i <= name.length; i++) {
    const charInMatch = i < name.length && matchSet.has(i);
    if (i === name.length || charInMatch !== inMatch) {
      if (buf) {
        parts.push(
          inMatch
            ? React.createElement('span', {
                key: keyIdx++,
                className: 'text-ctp-warning font-bold',
              }, buf)
            : React.createElement('span', { key: keyIdx++ }, buf),
        );
      }
      buf = i < name.length ? name[i] : '';
      inMatch = charInMatch;
    } else {
      buf += name[i];
    }
  }

  return React.createElement('span', { className: 'truncate' }, ...parts);
}

// ── Tree Node ─────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDoubleClick: (path: string) => void;
  selected: string | null;
  focused: string | null;
  gitMap: Map<string, string>;
  projectPath: string;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  // Multi-select
  multiSelectedPaths: Set<string>;
  onClickWithMods: (e: React.MouseEvent, node: FileNode) => void;
  // Drag-and-drop
  dropTargetPath: string | null;
  onDragStart: (e: React.DragEvent, node: FileNode) => void;
  onDragOver: (e: React.DragEvent, node: FileNode) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, node: FileNode) => void;
  // Filter
  filterMatchInfo: Map<string, number[]>;
}

const TreeNode = React.memo(function TreeNodeInner({
  node, depth, expanded, onToggle, onSelect, onDoubleClick,
  selected, focused, gitMap, projectPath, onContextMenu,
  multiSelectedPaths, onClickWithMods,
  dropTargetPath, onDragStart, onDragOver, onDragLeave, onDrop,
  filterMatchInfo,
}: TreeNodeProps) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selected === node.path;
  const isFocused = focused === node.path;
  const isMultiSelected = multiSelectedPaths.has(node.path);
  const isDropTarget = dropTargetPath === node.path;
  const ext = getExtension(node.name);
  const relPath = getRelativePath(node.path, projectPath);
  const gitStatus = gitMap.get(relPath);
  const filterMatches = filterMatchInfo.get(node.path);

  const bgClass = isDropTarget
    ? 'bg-ctp-accent/20 text-ctp-text ring-1 ring-inset ring-ctp-accent/50'
    : isSelected
      ? 'bg-surface-0 text-ctp-text'
      : isMultiSelected
        ? 'bg-ctp-accent/15 text-ctp-text'
        : isFocused
          ? 'bg-surface-0 text-ctp-text'
          : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text';

  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      onClickWithMods(e, node);
      return;
    }
    if (node.isDirectory) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  const handleDoubleClick = () => {
    if (!node.isDirectory) {
      onDoubleClick(node.path);
    }
  };

  const icon = node.isDirectory
    ? (isExpanded ? FolderOpenIcon : FolderIcon)
    : FileIcon(getFileIconColor(ext));

  const chevron = node.isDirectory
    ? (isExpanded ? ChevronDown : ChevronRight)
    : React.createElement('span', { className: 'w-3 flex-shrink-0' });

  const nameEl = filterMatches && filterMatches.length > 0
    ? React.createElement(HighlightedName, { name: node.name, matches: filterMatches })
    : React.createElement('span', { className: 'truncate' }, node.name);

  const elements: React.ReactNode[] = [
    React.createElement('div', {
      key: node.path,
      className: `mx-1.5 h-7 flex items-center gap-1.5 pr-2.5 cursor-pointer select-none text-[13px] rounded-md ${bgClass} transition-colors`,
      style: { paddingLeft: `${10 + depth * 14}px` },
      onClick: handleClick,
      onDoubleClick: handleDoubleClick,
      onContextMenu: (e: React.MouseEvent) => onContextMenu(e, node),
      // Drag-and-drop
      draggable: true,
      onDragStart: (e: React.DragEvent) => onDragStart(e, node),
      onDragOver: (e: React.DragEvent) => onDragOver(e, node),
      onDragLeave: (e: React.DragEvent) => onDragLeave(e),
      onDrop: (e: React.DragEvent) => onDrop(e, node),
      'data-path': node.path,
      role: 'treeitem',
      tabIndex: -1,
      'aria-expanded': node.isDirectory ? isExpanded : undefined,
      'aria-selected': isSelected,
      'aria-level': depth + 1,
    },
      chevron,
      icon,
      nameEl,
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
          onDoubleClick,
          selected,
          focused,
          gitMap,
          projectPath,
          onContextMenu,
          multiSelectedPaths,
          onClickWithMods,
          dropTargetPath,
          onDragStart,
          onDragOver,
          onDragLeave,
          onDrop,
          filterMatchInfo,
        }),
      );
    }
  }

  return React.createElement(React.Fragment, null, ...elements);
}, (prev, next) => {
  if (prev.node !== next.node || prev.depth !== next.depth || prev.projectPath !== next.projectPath) return false;

  const wasExpanded = prev.expanded.has(prev.node.path);
  const isExpanded = next.expanded.has(next.node.path);
  if (wasExpanded !== isExpanded) return false;

  if ((prev.selected === prev.node.path) !== (next.selected === next.node.path)) return false;
  if ((prev.focused === prev.node.path) !== (next.focused === next.node.path)) return false;

  const prevRel = getRelativePath(prev.node.path, prev.projectPath);
  if (prev.gitMap.get(prevRel) !== next.gitMap.get(prevRel)) return false;

  if ((prev.multiSelectedPaths.has(prev.node.path)) !== (next.multiSelectedPaths.has(next.node.path))) return false;
  if (prev.dropTargetPath === prev.node.path !== (next.dropTargetPath === next.node.path)) return false;

  // Filter match info change
  const prevMatch = prev.filterMatchInfo.get(prev.node.path);
  const nextMatch = next.filterMatchInfo.get(next.node.path);
  if (prevMatch !== nextMatch) {
    if (!prevMatch || !nextMatch || prevMatch.length !== nextMatch.length) return false;
  }

  // Expanded nodes must re-render when collections change (children may be affected)
  if (isExpanded && (prev.expanded !== next.expanded || prev.gitMap !== next.gitMap
    || prev.selected !== next.selected || prev.focused !== next.focused
    || prev.multiSelectedPaths !== next.multiSelectedPaths
    || prev.dropTargetPath !== next.dropTargetPath
    || prev.filterMatchInfo !== next.filterMatchInfo)) return false;

  return true;
});

// ── Context menu ──────────────────────────────────────────────────────

/** The tree's right-click actions, for the shared PopupMenu. */
function contextMenuItems(multiSelectCount: number, onAction: (action: string) => void): MenuEntry[] {
  const item = (id: string, label: string, danger = false): MenuItem => ({ id, label, danger, onSelect: () => onAction(id) });
  if (multiSelectCount > 1) return [item('deleteSelected', `Delete ${multiSelectCount} items`, true)];
  return [
    item('newFile', 'New file'),
    item('newFolder', 'New folder'),
    { id: 'sep-edit', separator: true },
    item('rename', 'Rename'),
    item('copy', 'Copy'),
    { id: 'sep-delete', separator: true },
    item('delete', 'Delete', true),
  ];
}

// ── FileTree (SidebarPanel) ───────────────────────────────────────────

export function FileTree({ api: rawApi }: { api: PluginAPI }) {
  // New chrome: the root, search and git badges follow the sidebar selection
  // (agent worktree or project root) and the worktree picker is hidden (spec §4.5).
  const { api, root: scopeRoot } = useFilesScope(rawApi);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [gitMap, setGitMap] = useState<Map<string, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  // Nav-pane selection — tracks the last node the user clicked in the tree
  // (file OR folder).  Distinct from selectedPath, which syncs to the active
  // editor tab.  Used so the toolbar's New File/Folder targets the folder the
  // user picked, not the editor's parent dir.  Wave 10 #2.
  const [navSelectedPath, setNavSelectedPath] = useState<string | null>(null);
  const scopeRootRef = useRef(scopeRoot);
  scopeRootRef.current = scopeRoot;
  const [rootPath, setRootPath] = useState<string>(() => scopeRoot ?? '.');
  const [worktrees, setWorktrees] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>('');
  // Filter
  const [filterText, setFilterText] = useState<string>('');
  // Multi-select
  const [multiSelectedPaths, setMultiSelectedPaths] = useState<Set<string>>(new Set());
  const lastClickedPathRef = useRef<string | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  // Drag-and-drop
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);
  const dragEnterCounterRef = useRef<number>(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandedRef = useRef<Set<string>>(expanded);
  expandedRef.current = expanded;
  selectedPathRef.current = selectedPath;
  const expandedSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const projectPath = api.context.projectPath || '';
  const [showHidden, setShowHidden] = useState(() => api.settings.get<boolean>('showHiddenFiles') ?? true);
  const loadVersionRef = useRef(0);

  // Compute filtered view whenever filter text or tree changes
  const filterResult = useMemo(() => {
    if (!filterText.trim()) return null;
    return filterTreeNodes(tree, filterText.trim(), projectPath);
  }, [tree, filterText, projectPath]);

  const displayTree = filterResult ? filterResult.filteredNodes : tree;
  const filterMatchInfo = filterResult ? filterResult.matchInfos : new Map<string, number[]>();
  // When filtering, auto-expand dirs with matches (merged with user-expanded set)
  const effectiveExpanded = useMemo(() => {
    if (!filterResult) return expanded;
    return new Set([...expanded, ...filterResult.autoExpand]);
  }, [expanded, filterResult]);

  // Collect all visible nodes for keyboard navigation
  const getVisibleNodes = useCallback((): FileNode[] => {
    const result: FileNode[] = [];
    const collect = (nodes: FileNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.isDirectory && effectiveExpanded.has(node.path) && node.children) {
          collect(node.children);
        }
      }
    };
    collect(displayTree);
    return result;
  }, [displayTree, effectiveExpanded]);

  // Load tree from API — fetches root + expanded children, then applies a single setTree
  const loadTree = useCallback(async () => {
    const version = ++loadVersionRef.current;
    try {
      const nodes = await api.files.readTree(rootPath, { includeHidden: showHidden, depth: 1 });
      if (loadVersionRef.current !== version) return;

      // Re-fetch children for currently expanded folders so content stays fresh
      const currentExpanded = expandedRef.current;
      let expandedResults: Array<{ dirPath: string; children: FileNode[] }> = [];

      if (currentExpanded.size > 0) {
        const results = await Promise.all(
          Array.from(currentExpanded).map(async (dirPath) => {
            const relPath = getRelativePath(dirPath, projectPath);
            try {
              const children = await api.files.readTree(relPath, { includeHidden: showHidden, depth: 1 });
              return { dirPath, children };
            } catch {
              return null;
            }
          }),
        );
        if (loadVersionRef.current !== version) return;
        expandedResults = results.filter((r): r is { dirPath: string; children: FileNode[] } => r !== null);
      }

      // Single setTree — merge root and expanded children together to avoid double render
      setTree(prev => {
        let merged = mergeTreePreservingChildren(prev, nodes);
        for (const result of expandedResults) {
          merged = updateNodeChildren(merged, result.dirPath, result.children);
        }
        return merged;
      });
    } catch {
      if (loadVersionRef.current !== version) return;
      setTree([]);
    }
  }, [api, showHidden, rootPath, projectPath]);

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

  // Load current branch — when viewing a worktree, resolve branch from that directory
  const loadBranch = useCallback(async () => {
    try {
      const branch = await api.git.currentBranch(rootPath !== '.' ? rootPath : undefined);
      setCurrentBranch(branch);
    } catch {
      setCurrentBranch('');
    }
  }, [api, rootPath]);

  // Stable refs for load functions — used inside effects to avoid re-registration
  const loadTreeRef = useRef(loadTree);
  loadTreeRef.current = loadTree;
  const loadGitStatusRef = useRef(loadGitStatus);
  loadGitStatusRef.current = loadGitStatus;
  const loadBranchRef = useRef(loadBranch);
  loadBranchRef.current = loadBranch;

  // Load worktree list
  const loadWorktrees = useCallback(async () => {
    try {
      const entries = await api.files.readTree('.clubhouse/agents', { depth: 1 });
      setWorktrees(entries.filter((e) => e.isDirectory).map((e) => e.name));
    } catch {
      setWorktrees([]);
    }
  }, [api]);
  const loadWorktreesRef = useRef(loadWorktrees);
  loadWorktreesRef.current = loadWorktrees;

  // Reveal a file in the tree — expand parents, scroll to it, set selected
  const revealFile = useCallback(async (relPath: string) => {
    if (!relPath) return;
    const parts = relPath.split('/');
    // Build list of ancestor absolute paths
    const dirsToExpand: string[] = [];
    let accRel = '';
    for (let i = 0; i < parts.length - 1; i++) {
      accRel = accRel ? `${accRel}/${parts[i]}` : parts[i];
      dirsToExpand.push(`${projectPath}/${accRel}`);
    }

    // Load children for not-yet-expanded dirs and accumulate new expanded set
    const newExpanded = new Set(expandedRef.current);
    for (const dirPath of dirsToExpand) {
      if (!newExpanded.has(dirPath)) {
        const relDir = getRelativePath(dirPath, projectPath);
        try {
          const children = await api.files.readTree(relDir, { includeHidden: showHidden, depth: 1 });
          setTree(prev => updateNodeChildren(prev, dirPath, children));
          newExpanded.add(dirPath);
        } catch {
          // ignore — directory may not exist
        }
      }
    }
    setExpanded(newExpanded);

    const absPath = `${projectPath}/${relPath}`;
    setSelectedPath(absPath);
    setFocusedPath(absPath);

    requestAnimationFrame(() => {
      if (containerRef.current) {
        const el = containerRef.current.querySelector(`[data-path="${CSS.escape(absPath)}"]`);
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }, [api, projectPath, showHidden]);

  const revealFileRef = useRef(revealFile);
  revealFileRef.current = revealFile;

  // Restore persisted state on mount
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const savedRoot = await api.storage.project.read('files:lastRootPath');
        if (cancelled) return;
        // In the new chrome the scope decides the root; the saved root is the legacy picker's.
        if (scopeRootRef.current === null && typeof savedRoot === 'string' && savedRoot) {
          setRootPath(savedRoot);
        }

        // Restore expanded paths
        const savedExpanded = await api.storage.project.read('files:expandedPaths');
        if (!cancelled && Array.isArray(savedExpanded) && savedExpanded.length > 0) {
          const validPaths = savedExpanded.filter((p: unknown) => typeof p === 'string') as string[];
          const absExpanded = new Set(validPaths.map(p => `${projectPath}/${p}`));
          setExpanded(absExpanded);
          // Trigger loadTree so it picks up the restored expanded set
          setTimeout(() => { if (!cancelled) loadTreeRef.current(); }, 50);
        }

        // Tab restore is handled by FileViewer — sync selected from active tab
        const activeTab = fileState.getActiveTab();
        if (activeTab) {
          setSelectedPath(`${projectPath}/${activeTab.filePath}`);
        }
      } catch {
        // Fresh start
      }
    }
    restore();
    return () => { cancelled = true; };
  }, [api, projectPath]);

  // Persist expanded state (debounced) — saves relative paths
  useEffect(() => {
    if (expandedSaveTimerRef.current) clearTimeout(expandedSaveTimerRef.current);
    expandedSaveTimerRef.current = setTimeout(() => {
      const relPaths = Array.from(expanded).map(p => getRelativePath(p, projectPath));
      api.storage.project.write('files:expandedPaths', relPaths).catch(() => {});
    }, 500);
    return () => {
      if (expandedSaveTimerRef.current) clearTimeout(expandedSaveTimerRef.current);
    };
  }, [expanded, api, projectPath]);

  // Load when meaningful dependencies change (rootPath, showHidden, api)
  useEffect(() => {
    loadTreeRef.current();
    loadGitStatusRef.current();
    loadBranchRef.current();
    loadWorktrees();
  }, [rootPath, showHidden, loadWorktrees]);

  // Subscribe to fileState refresh signals + auto-reveal active file
  const lastRefreshRef = useRef(fileState.refreshCount);
  const lastRevealedPathRef = useRef<string | null>(null);
  useEffect(() => {
    return fileState.subscribe(() => {
      // Sync selected path — convert relative to absolute for tree highlighting
      const relPath = fileState.selectedPath;
      setSelectedPath(relPath ? `${projectPath}/${relPath}` : null);

      // Only reload tree when an explicit refresh was triggered
      if (fileState.refreshCount !== lastRefreshRef.current) {
        lastRefreshRef.current = fileState.refreshCount;
        loadTreeRef.current();
        loadGitStatusRef.current();
        loadBranchRef.current();
        loadWorktreesRef.current();
      }

      // Auto-reveal when the active file changes
      const activeTab = fileState.getActiveTab();
      const activePath = activeTab?.filePath ?? null;
      if (activePath && activePath !== lastRevealedPathRef.current) {
        lastRevealedPathRef.current = activePath;
        revealFileRef.current(activePath);
      }
    });
  }, [projectPath]);

  // Subscribe to settings changes — updates state, which triggers reload via effect deps
  useEffect(() => {
    const disposable = api.settings.onChange((key) => {
      if (key === 'showHiddenFiles') {
        setShowHidden(api.settings.get<boolean>('showHiddenFiles') ?? true);
      }
    });
    return () => disposable.dispose();
  }, [api]);

  // File watching — auto-refresh tree on external changes
  // Uses refs so the watcher doesn't re-register when callbacks change
  useEffect(() => {
    const disposable = api.files.watch('**/*', () => {
      if (watchDebounceRef.current) clearTimeout(watchDebounceRef.current);
      watchDebounceRef.current = setTimeout(() => {
        loadTreeRef.current();
        loadGitStatusRef.current();
        loadBranchRef.current();
        loadWorktreesRef.current();
      }, 500);
    });
    return () => {
      if (watchDebounceRef.current) clearTimeout(watchDebounceRef.current);
      disposable.dispose();
    };
  }, [api]);

  // Expand directory — lazy load children
  const toggleExpand = useCallback(async (dirPath: string) => {
    setFocusedPath(dirPath);
    // Wave 10 #2: clicking a folder selects it as the nav target so the
    // toolbar's New File/Folder lands inside it, not in the active editor's
    // parent dir.
    setNavSelectedPath(dirPath);
    setMultiSelectedPaths(new Set());
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
      setTree(prev => updateNodeChildren(prev, dirPath, children));
    } catch {
      // ignore
    }
  }, [api, projectPath, showHidden]);

  // Select file — single-click opens as preview tab
  const selectFile = useCallback((path: string) => {
    setSelectedPath(path);
    setNavSelectedPath(path);
    setFocusedPath(path);
    setMultiSelectedPaths(new Set());
    const relPath = getRelativePath(path, projectPath);
    fileState.openTab(relPath, { preview: true });
  }, [projectPath]);

  // Double-click — opens as permanent (pinned) tab
  const openFilePermanently = useCallback((path: string) => {
    setSelectedPath(path);
    setNavSelectedPath(path);
    setFocusedPath(path);
    setMultiSelectedPaths(new Set());
    const relPath = getRelativePath(path, projectPath);
    fileState.openTab(relPath, { preview: false });
  }, [projectPath]);

  // Click with modifier keys (Cmd/Ctrl/Shift) — multi-select
  const handleClickWithMods = useCallback((e: React.MouseEvent, node: FileNode) => {
    if (e.shiftKey && lastClickedPathRef.current) {
      // Range selection
      const visible = getVisibleNodes();
      const fromIdx = visible.findIndex(n => n.path === lastClickedPathRef.current);
      const toIdx = visible.findIndex(n => n.path === node.path);
      if (fromIdx !== -1 && toIdx !== -1) {
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        const newPaths = new Set<string>();
        for (let i = start; i <= end; i++) {
          newPaths.add(visible[i].path);
        }
        setMultiSelectedPaths(newPaths);
      }
    } else {
      // Cmd/Ctrl toggle — include the primary selected item when starting a new multi-selection
      setMultiSelectedPaths(prev => {
        const next = new Set(prev);
        if (next.size === 0 && selectedPathRef.current) {
          next.add(selectedPathRef.current);
        }
        if (next.has(node.path)) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });
    }
    lastClickedPathRef.current = node.path;
    setFocusedPath(node.path);
  }, [getVisibleNodes]);

  // Handle root path change (worktree selector)
  const resetForRoot = useCallback((newRoot: string) => {
    setRootPath(newRoot);
    setExpanded(new Set());
    setSelectedPath(null);
    setFocusedPath(null);
    setMultiSelectedPaths(new Set());
    fileState.setSelectedPath(null);
  }, []);
  const handleRootChange = useCallback((newRoot: string) => {
    resetForRoot(newRoot);
    api.storage.project.write('files:lastRootPath', newRoot).catch(() => {});
    api.storage.project.write('files:lastSelectedPath', '').catch(() => {});
  }, [api, resetForRoot]);

  // Follow scope changes without touching the legacy picker's saved root.
  useEffect(() => {
    if (scopeRoot !== null && scopeRoot !== rootPath) resetForRoot(scopeRoot);
  }, [scopeRoot, rootPath, resetForRoot]);

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

  // Resolve the directory the toolbar's New File/Folder should target.  Prefer
  // the user's last nav-pane click (folder OR file). Fall back to selectedPath
  // (the active editor's file) for the case where the user hasn't clicked
  // anything in the tree yet.  Wave 10 #2.
  const resolveTargetDir = useCallback((): string => {
    const candidate = navSelectedPath || selectedPath;
    if (!candidate) return rootPath === '.' ? '' : rootPath;
    const findNode = (nodes: FileNode[]): FileNode | undefined => {
      for (const n of nodes) {
        if (n.path === candidate) return n;
        if (n.children) {
          const found = findNode(n.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    const node = findNode(tree);
    const relCandidate = getRelativePath(candidate, projectPath);
    if (node?.isDirectory) return relCandidate;
    return relCandidate.replace(/\/[^/]+$/, '') || (rootPath === '.' ? '' : rootPath);
  }, [navSelectedPath, selectedPath, projectPath, rootPath, tree]);

  // New file at root or selected directory
  const handleNewFile = useCallback(async () => {
    const name = await api.ui.showInput('File name');
    if (!name) return;
    const dir = resolveTargetDir();
    const newPath = dir ? `${dir}/${name}` : name;
    try {
      await api.files.writeFile(newPath, '');
      // Auto-expand the parent so the user can see the new file even when
      // the target was a previously-collapsed empty folder.  Wave 10 #1.
      if (dir) {
        const absDir = `${projectPath}/${dir}`;
        setExpanded((prev) => new Set(prev).add(absDir));
        try {
          const children = await api.files.readTree(dir, { includeHidden: showHidden, depth: 1 });
          setTree(prev => updateNodeChildren(prev, absDir, children));
        } catch { /* ignore */ }
      }
      loadTree();
      loadGitStatus();
    } catch (err) {
      api.ui.showError(`Failed to create file: ${err}`);
    }
  }, [api, projectPath, showHidden, resolveTargetDir, loadTree, loadGitStatus]);

  // New folder at root or selected directory
  const handleNewFolder = useCallback(async () => {
    const name = await api.ui.showInput('Folder name');
    if (!name) return;
    const dir = resolveTargetDir();
    const newPath = dir ? `${dir}/${name}` : name;
    try {
      await api.files.mkdir(newPath);
      if (dir) {
        const absDir = `${projectPath}/${dir}`;
        setExpanded((prev) => new Set(prev).add(absDir));
        try {
          const children = await api.files.readTree(dir, { includeHidden: showHidden, depth: 1 });
          setTree(prev => updateNodeChildren(prev, absDir, children));
        } catch { /* ignore */ }
      }
      loadTree();
      loadGitStatus();
    } catch (err) {
      api.ui.showError(`Failed to create folder: ${err}`);
    }
  }, [api, projectPath, showHidden, resolveTargetDir, loadTree, loadGitStatus]);

  // File operations (context menu)
  const handleContextAction = useCallback(async (action: string, node: FileNode) => {
    const parentDir = node.isDirectory
      ? getRelativePath(node.path, projectPath)
      : getRelativePath(node.path, projectPath).replace(/\/[^/]+$/, '') || '.';

    // Wave 10 #1: when the target is an empty / collapsed folder, expand it
    // and lazy-load its children so the newly-created item is visible
    // immediately. Without this the folder still looks empty after a
    // right-click → New File, which is what users described as "right-click
    // can't add to it".
    const revealInsideFolder = async (dirNode: FileNode) => {
      if (!dirNode.isDirectory) return;
      setExpanded((prev) => new Set(prev).add(dirNode.path));
      try {
        const relPath = getRelativePath(dirNode.path, projectPath);
        const children = await api.files.readTree(relPath, { includeHidden: showHidden, depth: 1 });
        setTree(prev => updateNodeChildren(prev, dirNode.path, children));
      } catch { /* ignore */ }
    };

    switch (action) {
      case 'newFile': {
        const name = await api.ui.showInput('File name');
        if (!name) return;
        const newPath = parentDir === '.' ? name : `${node.isDirectory ? getRelativePath(node.path, projectPath) : parentDir}/${name}`;
        await api.files.writeFile(newPath, '');
        await revealInsideFolder(node);
        break;
      }
      case 'newFolder': {
        const name = await api.ui.showInput('Folder name');
        if (!name) return;
        const newPath = parentDir === '.' ? name : `${node.isDirectory ? getRelativePath(node.path, projectPath) : parentDir}/${name}`;
        await api.files.mkdir(newPath);
        await revealInsideFolder(node);
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
      case 'deleteSelected': {
        // Multi-select delete — includes the right-clicked node plus all multi-selected
        const pathsToDelete = new Set([node.path, ...multiSelectedPaths]);
        const count = pathsToDelete.size;
        const confirmed = await api.ui.showConfirm(`Delete ${count} item${count === 1 ? '' : 's'}? This cannot be undone.`);
        if (!confirmed) return;
        for (const p of pathsToDelete) {
          try {
            await api.files.delete(getRelativePath(p, projectPath));
          } catch {
            // continue deleting others
          }
        }
        setMultiSelectedPaths(new Set());
        break;
      }
    }

    // Refresh tree after operation
    loadTree();
    loadGitStatus();
  }, [api, projectPath, showHidden, loadTree, loadGitStatus, multiSelectedPaths]);

  // Drag-and-drop handlers
  // dragSourcesRef holds *every* path included in the drag — the directly-
  // clicked node plus any other multi-selected items.  Wave 10 #3.
  const dragSourcesRef = useRef<string[]>([]);
  const handleDragStart = useCallback((e: React.DragEvent, node: FileNode) => {
    // If the dragged item is part of an active multi-selection, include the
    // whole stack; otherwise fall back to a single-item drag.
    const sources = multiSelectedPaths.has(node.path)
      ? Array.from(new Set([node.path, ...multiSelectedPaths]))
      : [node.path];
    dragSourcesRef.current = sources;
    dragSourceRef.current = node.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sources.join('\n'));
  }, [multiSelectedPaths]);

  const handleDragOver = useCallback((e: React.DragEvent, node: FileNode) => {
    const sources = dragSourcesRef.current;
    if (sources.length === 0) return;
    if (!node.isDirectory) return; // only directories are valid drop targets
    // Prevent dropping any source folder into itself or a descendant
    for (const srcPath of sources) {
      if (node.path === srcPath) return;
      if (node.path.startsWith(srcPath + '/')) return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetPath(node.path);
  }, []);

  const handleDragLeave = useCallback((_e: React.DragEvent) => {
    // Use a counter to handle nested drag enter/leave
    dragEnterCounterRef.current -= 1;
    if (dragEnterCounterRef.current <= 0) {
      dragEnterCounterRef.current = 0;
      setDropTargetPath(null);
    }
  }, []);

  const handleDragEnter = useCallback((_e: React.DragEvent) => {
    dragEnterCounterRef.current += 1;
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetNode: FileNode) => {
    e.preventDefault();
    dragEnterCounterRef.current = 0;
    setDropTargetPath(null);

    const sources = dragSourcesRef.current;
    dragSourcesRef.current = [];
    dragSourceRef.current = null;

    if (sources.length === 0 || !targetNode.isDirectory) return;

    // Compute moves; skip any source that's the target or already inside it.
    const destDir = getRelativePath(targetNode.path, projectPath);
    const moves: Array<{ srcRel: string; destRel: string; fileName: string }> = [];
    for (const srcPath of sources) {
      if (targetNode.path === srcPath) continue;
      if (targetNode.path.startsWith(srcPath + '/')) continue;
      const srcRel = getRelativePath(srcPath, projectPath);
      const fileName = srcRel.split('/').pop() ?? srcRel;
      const destRel = destDir === '.' ? fileName : `${destDir}/${fileName}`;
      if (srcRel === destRel) continue;
      moves.push({ srcRel, destRel, fileName });
    }
    if (moves.length === 0) return;

    const confirmed = await api.ui.showConfirm(
      moves.length === 1
        ? `Move "${moves[0].fileName}" to "${destDir}"?`
        : `Move ${moves.length} items to "${destDir}"?`,
    );
    if (!confirmed) return;

    let failed = 0;
    for (const m of moves) {
      try {
        await api.files.rename(m.srcRel, m.destRel);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      api.ui.showError(`Failed to move ${failed} of ${moves.length} item${moves.length === 1 ? '' : 's'}`);
    }
    setMultiSelectedPaths(new Set());
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
      case 'ArrowRight': {
        e.preventDefault();
        if (focusedPath) {
          const node = visible.find((n) => n.path === focusedPath);
          if (node?.isDirectory && !effectiveExpanded.has(node.path)) {
            toggleExpand(node.path);
          }
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (focusedPath) {
          const node = visible.find((n) => n.path === focusedPath);
          if (node?.isDirectory && effectiveExpanded.has(node.path)) {
            toggleExpand(node.path);
          }
        }
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
              // Enter opens permanently (like double-click)
              openFilePermanently(node.path);
            }
          }
        }
        break;
      }
      case ' ': {
        e.preventDefault();
        if (focusedPath) {
          const node = visible.find((n) => n.path === focusedPath);
          if (node && !node.isDirectory) {
            selectFile(node.path);
          }
        }
        break;
      }
      case 'Escape': {
        if (filterText) {
          setFilterText('');
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
  }, [focusedPath, filterText, getVisibleNodes, toggleExpand, effectiveExpanded, selectFile, openFilePermanently, handleContextAction]);

  // Initialize focus on container focus
  const handleFocus = useCallback(() => {
    if (!focusedPath) {
      const visible = getVisibleNodes();
      setFocusedPath(selectedPath ?? visible[0]?.path ?? null);
    }
  }, [focusedPath, selectedPath, getVisibleNodes]);

  // Scroll focused node into view
  useEffect(() => {
    if (focusedPath && containerRef.current) {
      const el = containerRef.current.querySelector(`[data-path="${CSS.escape(focusedPath)}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedPath]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const selectionCount = multiSelectedPaths.size;

  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const refreshAll = () => { loadTree(); loadGitStatus(); loadBranch(); loadWorktrees(); };
  const moreItems: MenuEntry[] = [
    { id: 'new-folder', label: 'New folder', onSelect: handleNewFolder },
    { id: 'sep-tree', separator: true },
    { id: 'expand-all', label: 'Expand all', onSelect: expandAll },
    { id: 'collapse-all', label: 'Collapse all', onSelect: collapseAll },
    { id: 'sep-search', separator: true },
    // The platform's binding (⌘⇧F or Ctrl+Shift+F), not a hardcoded "Cmd+Shift+F"
    { id: 'search', label: 'Search across files', shortcut: 'Meta+Shift+F', onSelect: () => fileState.setSearchMode(true) },
    { id: 'refresh', label: 'Refresh', shortcut: 'Meta+Shift+R', onSelect: refreshAll },
  ];

  const iconButton = (props: Record<string, unknown>, icon: React.ReactElement) =>
    React.createElement('button', {
      type: 'button',
      className: 'w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-md text-ctp-overlay1 hover:text-ctp-text hover:bg-surface-0 transition-colors focus-ring',
      ...props,
    }, icon);

  return React.createElement('div', {
    ref: containerRef,
    className: 'flex flex-col h-full bg-ctp-mantle text-ctp-text select-none focus-ring-inset',
    tabIndex: 0,
    role: 'tree',
    onKeyDown: handleKeyDown,
    onFocus: handleFocus,
    onDragEnter: handleDragEnter,
  },
    // Header: one row (filter, new file, more). The classic layout adds its worktree picker above it.
    React.createElement('div', {
      className: 'flex flex-col flex-shrink-0 pt-1.5',
    },
      // Classic layout only: branch and worktree picker. In the new chrome the
      // sidebar selection picks the worktree and the scope line names it.
      scopeRoot === null && (currentBranch || rootPath !== '.' || worktrees.length > 0)
        ? React.createElement('div', {
            className: 'flex items-center gap-2 px-3.5 pb-1.5 text-xs',
          },
            (currentBranch || rootPath !== '.')
              ? React.createElement('div', {
                  className: 'flex items-center gap-1 text-ctp-overlay1 flex-shrink-0',
                  title: currentBranch ? `Branch: ${currentBranch}` : 'No worktree',
                },
                  GitBranchIcon,
                  React.createElement('span', { className: 'truncate max-w-[120px]' },
                    currentBranch || 'No worktree'),
                )
              : null,
            worktrees.length > 0
              ? React.createElement('select', {
                  className: 'flex-1 min-w-0 h-7 text-xs bg-surface-0 text-ctp-text border-none rounded-md px-1.5 cursor-pointer truncate focus-ring',
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
              : null,
          )
        : null,

      React.createElement('div', {
        className: 'flex items-center gap-1 px-2 pb-1.5',
      },
        React.createElement('div', { className: 'relative flex-1 min-w-0' },
          React.createElement('span', {
            className: 'absolute left-2 top-1/2 -translate-y-1/2 text-ctp-overlay1 pointer-events-none flex',
            'aria-hidden': true,
          }, SearchIcon),
          React.createElement('input', {
            type: 'text',
            placeholder: 'Filter files',
            value: filterText,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setFilterText(e.target.value),
            onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(), // prevent tree keyboard nav while typing
            className: 'w-full h-7 bg-surface-0 text-ctp-text placeholder:text-ctp-overlay1 text-xs rounded-md pl-7 pr-6 focus-ring-dim',
            'aria-label': 'Filter files',
          }),
          filterText
            ? React.createElement('button', {
                type: 'button',
                className: 'absolute right-1.5 top-1/2 -translate-y-1/2 text-ctp-overlay1 hover:text-ctp-text leading-none',
                onClick: () => setFilterText(''),
                title: 'Clear filter',
                tabIndex: -1,
              }, '\u00D7')
            : null,
        ),
        iconButton({ onClick: handleNewFile, title: 'New file', 'aria-label': 'New file' }, NewFileIcon),
        iconButton({
          ref: moreBtnRef,
          title: 'More file actions',
          'aria-label': 'More file actions',
          'aria-haspopup': 'menu',
          'aria-expanded': moreMenu !== null,
          'data-testid': 'files-more-btn',
          onClick: () => {
            const r = moreBtnRef.current?.getBoundingClientRect();
            setMoreMenu(moreMenu ? null : { x: (r?.right ?? 0) - 180, y: (r?.bottom ?? 0) + 4 });
          },
        }, MoreIcon),
      ),

      selectionCount > 1
        ? React.createElement('div', {
            className: 'px-3.5 pb-1 text-xs text-ctp-overlay1',
            title: `${selectionCount} items selected`,
          }, `${selectionCount} selected`)
        : null,
    ),

    // Tree
    React.createElement('div', { className: 'flex-1 overflow-auto pb-1' },
      displayTree.length === 0
        ? React.createElement('div', { className: 'px-3.5 py-1 text-xs text-ctp-overlay1' },
            filterText ? 'No matching files' : 'No files found',
          )
        : displayTree.map((node) =>
            React.createElement(TreeNode, {
              key: node.path,
              node,
              depth: 0,
              expanded: effectiveExpanded,
              onToggle: toggleExpand,
              onSelect: selectFile,
              onDoubleClick: openFilePermanently,
              selected: selectedPath,
              focused: focusedPath,
              gitMap,
              projectPath,
              onContextMenu: handleContextMenu,
              multiSelectedPaths,
              onClickWithMods: handleClickWithMods,
              dropTargetPath,
              onDragStart: handleDragStart,
              onDragOver: handleDragOver,
              onDragLeave: handleDragLeave,
              onDrop: handleDrop,
              filterMatchInfo,
            }),
          ),
    ),

    // Context menu
    contextMenu
      ? React.createElement(PopupMenu, {
          items: contextMenuItems(
            multiSelectedPaths.size > 1 ? multiSelectedPaths.size : 0,
            (action: string) => handleContextAction(action, contextMenu.node),
          ),
          position: { x: contextMenu.x, y: contextMenu.y },
          label: 'File actions',
          testId: 'files-tree-menu',
          onClose: () => setContextMenu(null),
        })
      : null,

    moreMenu
      ? React.createElement(PopupMenu, {
          items: moreItems,
          position: moreMenu,
          label: 'More file actions',
          testId: 'files-more-menu',
          onClose: () => { setMoreMenu(null); moreBtnRef.current?.focus(); },
        })
      : null,
  );
}
