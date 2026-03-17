import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { PluginAPI } from '../../../../shared/plugin-types';
import type { FileNode } from '../../../../shared/types';
import { getFileIconColor } from '../files/file-icons';

// ── Icons ──────────────────────────────────────────────────────────────

const FolderIcon = React.createElement('svg', {
  width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'text-ctp-info flex-shrink-0',
}, React.createElement('path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }));

const FolderOpenIcon = React.createElement('svg', {
  width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'text-ctp-info flex-shrink-0',
}, React.createElement('path', { d: 'M5 19a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 3h9a2 2 0 0 1 2 2v1' }),
   React.createElement('path', { d: 'M22 10H10a2 2 0 0 0-2 2l-1 7h15l1-7a2 2 0 0 0-2-2z' }));

const FileIcon = (color: string) => React.createElement('svg', {
  width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: `${color} flex-shrink-0`,
}, React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
   React.createElement('polyline', { points: '14 2 14 8 20 8' }));

const ChevronRight = React.createElement('svg', {
  width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'flex-shrink-0 text-ctp-overlay0',
}, React.createElement('polyline', { points: '9 18 15 12 9 6' }));

const ChevronDown = React.createElement('svg', {
  width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: 'flex-shrink-0 text-ctp-overlay0',
}, React.createElement('polyline', { points: '6 9 12 15 18 9' }));

// ── Helpers ─────────────────────────────────────────────────────────────

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
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

/** Load directory children for lazy expansion */
async function loadChildren(
  api: PluginAPI,
  isAppMode: boolean,
  projectPath: string,
  dirPath: string,
): Promise<FileNode[]> {
  if (isAppMode) {
    const fullPath = dirPath ? `${projectPath}/${dirPath}` : projectPath;
    const tree = await window.clubhouse.file.readTree(fullPath);
    return tree.map((node: { name: string; path: string; isDirectory: boolean }) => ({
      name: node.name,
      path: dirPath ? `${dirPath}/${node.name}` : node.name,
      isDirectory: node.isDirectory,
    }));
  } else {
    const entries = await api.project.listDirectory(dirPath || '.');
    return entries.map((e) => ({
      name: e.name,
      path: dirPath ? `${dirPath}/${e.name}` : e.name,
      isDirectory: e.isDirectory,
    }));
  }
}

// ── Tree Node ───────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
}

const TreeNode = React.memo(function TreeNodeInner({
  node, depth, expanded, selectedPath, onToggle, onSelectFile,
}: TreeNodeProps) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selectedPath === node.path;
  const ext = getExtension(node.name);

  const bgClass = isSelected
    ? 'bg-surface-1 text-ctp-text font-medium'
    : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text';

  const handleClick = () => {
    if (node.isDirectory) {
      onToggle(node.path);
    } else {
      onSelectFile(node.path);
    }
  };

  const chevron = node.isDirectory
    ? (isExpanded ? ChevronDown : ChevronRight)
    : React.createElement('span', { className: 'w-2.5' });

  const icon = node.isDirectory
    ? (isExpanded ? FolderOpenIcon : FolderIcon)
    : FileIcon(getFileIconColor(ext));

  const elements: React.ReactNode[] = [
    React.createElement('div', {
      key: node.path,
      className: `flex items-center gap-1 px-1.5 py-0.5 cursor-pointer select-none text-[11px] rounded-sm ${bgClass} transition-colors`,
      style: { paddingLeft: `${4 + depth * 12}px` },
      onClick: handleClick,
      title: node.path,
    },
      chevron,
      icon,
      React.createElement('span', { className: 'truncate' }, node.name),
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
          selectedPath,
          onToggle,
          onSelectFile,
        }),
      );
    }
  }

  return React.createElement(React.Fragment, null, ...elements);
});

// ── Main CanvasFileTree ─────────────────────────────────────────────────

interface CanvasFileTreeProps {
  api: PluginAPI;
  projectPath: string;
  isAppMode: boolean;
  selectedPath: string | null;
  showHidden: boolean;
  onSelectFile: (path: string) => void;
}

export function CanvasFileTree({
  api, projectPath, isAppMode, selectedPath, showHidden, onSelectFile,
}: CanvasFileTreeProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Load root tree on mount
  useEffect(() => {
    setLoading(true);
    loadChildren(api, isAppMode, projectPath, '')
      .then((nodes) => {
        setTree(nodes);
        setLoading(false);
      })
      .catch(() => {
        setTree([]);
        setLoading(false);
      });
  }, [api, isAppMode, projectPath]);

  // Toggle directory expand/collapse with lazy loading
  const handleToggle = useCallback((dirPath: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        // Lazy-load children if not already loaded
        const findNode = (nodes: FileNode[]): FileNode | undefined => {
          for (const n of nodes) {
            if (n.path === dirPath) return n;
            if (n.isDirectory && n.children) {
              const found = findNode(n.children);
              if (found) return found;
            }
          }
          return undefined;
        };
        const node = findNode(tree);
        if (node && !node.children) {
          loadChildren(api, isAppMode, projectPath, dirPath)
            .then((children) => {
              setTree(prev => updateNodeChildren(prev, dirPath, children));
            })
            .catch(() => {
              // Failed to load — leave empty
            });
        }
      }
      return next;
    });
  }, [api, isAppMode, projectPath, tree]);

  // Filter hidden files
  const filteredTree = useMemo(() => {
    if (showHidden) return tree;
    const filterNodes = (nodes: FileNode[]): FileNode[] =>
      nodes
        .filter(n => !n.name.startsWith('.'))
        .map(n => n.isDirectory && n.children
          ? { ...n, children: filterNodes(n.children) }
          : n,
        );
    return filterNodes(tree);
  }, [tree, showHidden]);

  if (loading) {
    return React.createElement('div', {
      className: 'p-2 text-[11px] text-ctp-overlay0',
    }, 'Loading\u2026');
  }

  return React.createElement('div', {
    className: 'flex-1 overflow-y-auto overflow-x-hidden py-0.5',
  },
    ...filteredTree.map(node =>
      React.createElement(TreeNode, {
        key: node.path,
        node,
        depth: 0,
        expanded,
        selectedPath,
        onToggle: handleToggle,
        onSelectFile,
      }),
    ),
  );
}
