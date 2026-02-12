import { useEffect, useState, useRef, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useNotesStore, notesDir } from '../../stores/notesStore';
import { FileNode } from '../../../shared/types';

export function NotesList() {
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const { tree, selectedNote, loadNotes, setSelectedNote, createNote, deleteEntry, renameNote } = useNotesStore();
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeProject) {
      loadNotes(activeProject.path);
    }
  }, [activeProject, loadNotes]);

  useEffect(() => {
    if (renamingPath && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingPath]);

  const handleCreate = useCallback(async () => {
    if (!activeProject) return;
    const title = window.prompt('Note title:');
    if (!title?.trim()) return;
    await createNote(activeProject.path, notesDir(activeProject.path), title.trim());
  }, [activeProject, createNote]);

  const handleDelete = useCallback(async (notePath: string) => {
    if (!activeProject) return;
    const ok = window.confirm('Delete this note?');
    if (!ok) return;
    await deleteEntry(notePath, activeProject.path);
  }, [activeProject, deleteEntry]);

  const handleRenameStart = useCallback((notePath: string, currentName: string) => {
    setRenamingPath(notePath);
    setRenameValue(currentName);
  }, []);

  const handleRenameCommit = useCallback(async () => {
    if (!renamingPath || !activeProject || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    await renameNote(renamingPath, renameValue.trim(), activeProject.path);
    setRenamingPath(null);
  }, [renamingPath, renameValue, activeProject, renameNote]);

  // Flatten tree to get leaf notes (non-directory files)
  const flattenNotes = (nodes: FileNode[]): FileNode[] => {
    const result: FileNode[] = [];
    for (const node of nodes) {
      if (node.isDirectory && node.children) {
        result.push(...flattenNotes(node.children));
      } else if (!node.isDirectory) {
        result.push(node);
      }
    }
    return result;
  };

  const notes = flattenNotes(tree);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          Notes
        </span>
        <button
          onClick={handleCreate}
          className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer px-1"
          title="New Note"
        >
          +
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {notes.length === 0 && (
          <div className="px-3 py-2 text-xs text-ctp-subtext0">No notes yet</div>
        )}
        {notes.map((note: FileNode) => (
          <div
            key={note.path}
            className={`group flex items-center gap-1.5 py-1 px-3 cursor-pointer hover:bg-surface-0 ${
              selectedNote === note.path ? 'bg-surface-1' : ''
            }`}
            onClick={() => setSelectedNote(note.path)}
            onDoubleClick={() => handleRenameStart(note.path, note.name)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-ctp-subtext0">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            {renamingPath === note.path ? (
              <input
                ref={renameInputRef}
                className="flex-1 text-xs bg-ctp-surface0 text-ctp-text rounded px-1 py-0.5 outline-none border border-ctp-surface2"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRenameCommit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameCommit();
                  if (e.key === 'Escape') setRenamingPath(null);
                }}
              />
            ) : (
              <span className="flex-1 text-xs text-ctp-text truncate">{note.name}</span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(note.path);
              }}
              className="opacity-0 group-hover:opacity-100 text-ctp-subtext0 hover:text-ctp-red transition-opacity cursor-pointer p-0.5"
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
        ))}
      </div>
    </div>
  );
}
