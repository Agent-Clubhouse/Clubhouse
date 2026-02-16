import { useEffect, useState, useRef, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useNotesStore, notesDir } from '../../stores/notesStore';
import { DeleteNoteDialog } from './DeleteNoteDialog';
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
  const color = ext === 'md' ? 'text-ctp-subtext1' : 'text-ctp-subtext0';
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`flex-shrink-0 ${color}`}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}

interface DeleteTarget {
  path: string;
  name: string;
  isDirectory: boolean;
}

function NotesTreeNode({
  node,
  depth,
  selectedNote,
  renamingPath,
  renameValue,
  onSelect,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onCreateNote,
  onCreateFolder,
  renameInputRef,
}: {
  node: FileNode;
  depth: number;
  selectedNote: string | null;
  renamingPath: string | null;
  renameValue: string;
  onSelect: (path: string) => void;
  onRenameStart: (path: string, name: string) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelete: (target: DeleteTarget) => void;
  onCreateNote: (parentDir: string) => void;
  onCreateFolder: (parentDir: string) => void;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isSelected = selectedNote === node.path;

  if (node.isDirectory) {
    return (
      <div>
        <div
          className={`group flex items-center gap-1.5 py-0.5 pr-2 cursor-pointer hover:bg-surface-0 ${
            isSelected ? 'bg-surface-1' : ''
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-xs text-ctp-subtext0 w-3 text-center">
            {expanded ? '\u25BE' : '\u25B8'}
          </span>
          <FileIcon isDirectory name={node.name} />
          <span className="flex-1 text-xs text-ctp-text truncate">{node.name}</span>
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 flex-shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onCreateNote(node.path); }}
              className="text-ctp-subtext0 hover:text-ctp-text cursor-pointer p-0.5"
              title="New note in folder"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onCreateFolder(node.path); }}
              className="text-ctp-subtext0 hover:text-ctp-text cursor-pointer p-0.5"
              title="New folder"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <line x1="9" y1="14" x2="15" y2="14" />
              </svg>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete({ path: node.path, name: node.name, isDirectory: true });
              }}
              className="text-ctp-subtext0 hover:text-ctp-red cursor-pointer p-0.5"
              title="Delete folder"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          </div>
        </div>
        {expanded && node.children?.map((child) => (
          <NotesTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedNote={selectedNote}
            renamingPath={renamingPath}
            renameValue={renameValue}
            onSelect={onSelect}
            onRenameStart={onRenameStart}
            onRenameChange={onRenameChange}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            onDelete={onDelete}
            onCreateNote={onCreateNote}
            onCreateFolder={onCreateFolder}
            renameInputRef={renameInputRef}
          />
        ))}
      </div>
    );
  }

  const displayName = node.name.replace(/\.md$/, '');

  return (
    <div
      className={`group flex items-center gap-1.5 py-0.5 pr-2 cursor-pointer hover:bg-surface-0 ${
        isSelected ? 'bg-surface-1' : ''
      }`}
      style={{ paddingLeft: `${depth * 12 + 8 + 16}px` }}
      onClick={() => onSelect(node.path)}
      onDoubleClick={() => onRenameStart(node.path, displayName)}
    >
      <FileIcon isDirectory={false} name={node.name} />
      {renamingPath === node.path ? (
        <input
          ref={renameInputRef}
          className="flex-1 text-xs bg-ctp-surface0 text-ctp-text rounded px-1 py-0.5 outline-none border border-ctp-surface2"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit();
            if (e.key === 'Escape') onRenameCancel();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 text-xs text-ctp-text truncate">{displayName}</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete({ path: node.path, name: displayName, isDirectory: false });
        }}
        className="opacity-0 group-hover:opacity-100 text-ctp-subtext0 hover:text-ctp-red transition-opacity cursor-pointer p-0.5 flex-shrink-0"
        title="Delete note"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      </button>
    </div>
  );
}

export function NotesTree() {
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const { tree, selectedNote, loadNotes, setSelectedNote, createNote, createFolder, deleteEntry, renameNote } = useNotesStore();
  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeProject) {
      setLoading(true);
      loadNotes(activeProject.path).finally(() => setLoading(false));
    }
  }, [activeProject, loadNotes]);

  useEffect(() => {
    if (renamingPath && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingPath]);

  const rootDir = activeProject ? notesDir(activeProject.path) : '';

  const handleCreateNote = useCallback(async (parentDir: string) => {
    if (!activeProject) return;
    const title = window.prompt('Note title:');
    if (!title?.trim()) return;
    await createNote(activeProject.path, parentDir, title.trim());
  }, [activeProject, createNote]);

  const handleCreateFolder = useCallback(async (parentDir: string) => {
    if (!activeProject) return;
    const name = window.prompt('Folder name:');
    if (!name?.trim()) return;
    await createFolder(activeProject.path, parentDir, name.trim());
  }, [activeProject, createFolder]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || !activeProject) return;
    await deleteEntry(deleteTarget.path, activeProject.path);
    setDeleteTarget(null);
  }, [deleteTarget, activeProject, deleteEntry]);

  const handleRenameStart = useCallback((path: string, name: string) => {
    setRenamingPath(path);
    setRenameValue(name);
  }, []);

  const handleRenameCommit = useCallback(async () => {
    if (!renamingPath || !activeProject || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    await renameNote(renamingPath, renameValue.trim(), activeProject.path);
    setRenamingPath(null);
  }, [renamingPath, renameValue, activeProject, renameNote]);

  const refresh = useCallback(async () => {
    if (!activeProject) return;
    setLoading(true);
    await loadNotes(activeProject.path);
    setLoading(false);
  }, [activeProject, loadNotes]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          Notes
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => rootDir && handleCreateNote(rootDir)}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer px-1"
            title="New Note"
          >
            +
          </button>
          <button
            onClick={() => rootDir && handleCreateFolder(rootDir)}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer px-1"
            title="New Folder"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
          <button
            onClick={refresh}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer px-1"
            title="Refresh"
          >
            {loading ? '...' : '\u21BB'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {tree.length === 0 && !loading && (
          <div className="px-3 py-2 text-xs text-ctp-subtext0">No notes yet</div>
        )}
        {tree.map((node) => (
          <NotesTreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedNote={selectedNote}
            renamingPath={renamingPath}
            renameValue={renameValue}
            onSelect={setSelectedNote}
            onRenameStart={handleRenameStart}
            onRenameChange={setRenameValue}
            onRenameCommit={handleRenameCommit}
            onRenameCancel={() => setRenamingPath(null)}
            onDelete={setDeleteTarget}
            onCreateNote={handleCreateNote}
            onCreateFolder={handleCreateFolder}
            renameInputRef={renameInputRef}
          />
        ))}
      </div>
      {deleteTarget && (
        <DeleteNoteDialog
          entryName={deleteTarget.name}
          isDirectory={deleteTarget.isDirectory}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
