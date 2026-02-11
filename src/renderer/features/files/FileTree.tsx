import { useEffect, useState, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { FileNode } from '../../../shared/types';

function FileIcon({ isDirectory, name }: { isDirectory: boolean; name: string }) {
  if (isDirectory) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-indigo-300">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const colorMap: Record<string, string> = {
    ts: 'text-blue-300', tsx: 'text-blue-300',
    js: 'text-yellow-300', jsx: 'text-yellow-300',
    json: 'text-yellow-200',
    md: 'text-ctp-subtext1',
    css: 'text-purple-300', scss: 'text-purple-300',
    html: 'text-orange-300',
    py: 'text-green-300',
    rs: 'text-orange-300',
    go: 'text-cyan-300',
  };
  const color = colorMap[ext] || 'text-ctp-subtext0';
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`flex-shrink-0 ${color}`}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const { selectedFilePath, setSelectedFilePath } = useUIStore();
  const isSelected = selectedFilePath === node.path;

  if (node.isDirectory) {
    return (
      <div>
        <div
          className={`flex items-center gap-1.5 py-0.5 pr-2 cursor-pointer hover:bg-surface-0 ${
            isSelected ? 'bg-surface-1' : ''
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-xs text-ctp-subtext0 w-3 text-center">
            {expanded ? '\u25BE' : '\u25B8'}
          </span>
          <FileIcon isDirectory name={node.name} />
          <span className="text-xs text-ctp-text truncate">{node.name}</span>
        </div>
        {expanded && node.children?.map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 py-0.5 pr-2 cursor-pointer hover:bg-surface-0 ${
        isSelected ? 'bg-surface-1' : ''
      }`}
      style={{ paddingLeft: `${depth * 12 + 8 + 16}px` }}
      onClick={() => setSelectedFilePath(node.path)}
    >
      <FileIcon isDirectory={false} name={node.name} />
      <span className="text-xs text-ctp-text truncate">{node.name}</span>
    </div>
  );
}

export function FileTree() {
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeProject) return;
    setLoading(true);
    const nodes = await window.clubhouse.file.readTree(activeProject.path);
    setTree(nodes);
    setLoading(false);
  }, [activeProject]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          Files
        </span>
        <button
          onClick={refresh}
          className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
          title="Refresh"
        >
          {loading ? '...' : '\u21BB'}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {tree.length === 0 && !loading && (
          <div className="px-3 py-2 text-xs text-ctp-subtext0">No files found</div>
        )}
        {tree.map((node) => (
          <TreeNode key={node.path} node={node} depth={0} />
        ))}
      </div>
    </div>
  );
}
