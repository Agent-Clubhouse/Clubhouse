import { useEffect, useState, useCallback, useRef } from 'react';
import { useNotesStore } from '../../stores/notesStore';
import { MonacoCodeEditor } from '../files/MonacoEditor';
import { MarkdownPreview } from '../files/MarkdownPreview';
import { SendToAgentDialog } from './SendToAgentDialog';

type ViewMode = 'preview' | 'source';

export function NoteEditor() {
  const { selectedNote } = useNotesStore();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [isDirty, setIsDirty] = useState(false);
  const [showSendDialog, setShowSendDialog] = useState(false);
  const activeNoteRef = useRef<string | null>(null);

  const fileName = selectedNote?.split('/').pop()?.replace(/\.md$/, '') || '';

  useEffect(() => {
    const prev = activeNoteRef.current;
    if (prev && prev !== selectedNote && isDirty) {
      const discard = window.confirm('You have unsaved changes. Discard them and switch notes?');
      if (!discard) {
        useNotesStore.getState().setSelectedNote(prev);
        return;
      }
    }
    activeNoteRef.current = selectedNote;
    setIsDirty(false);
    setViewMode('preview');
  }, [selectedNote]);

  useEffect(() => {
    if (!selectedNote) {
      setContent(null);
      return;
    }
    setLoading(true);
    window.clubhouse.file.read(selectedNote)
      .then((text: string) => {
        setContent(text);
        setLoading(false);
      })
      .catch(() => {
        setContent(null);
        setLoading(false);
      });
  }, [selectedNote]);

  const handleSave = useCallback(async (newContent: string) => {
    if (!selectedNote) return;
    await window.clubhouse.file.write(selectedNote, newContent);
    setContent(newContent);
  }, [selectedNote]);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
  }, []);

  if (!selectedNote) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <div className="text-center text-ctp-subtext0">
          <p className="text-lg mb-2">No note selected</p>
          <p className="text-sm">Select a note from the sidebar or create a new one</p>
        </div>
      </div>
    );
  }

  if (loading || content === null) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0 text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-full bg-ctp-base flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-surface-0 bg-ctp-mantle flex-shrink-0">
        <span className="text-sm font-medium text-ctp-text">{fileName}</span>
        {isDirty && (
          <span className="w-2 h-2 rounded-full bg-ctp-peach flex-shrink-0" title="Unsaved changes" />
        )}
        <span className="text-xs px-1.5 py-0.5 rounded bg-surface-1 text-ctp-subtext0">md</span>
        <div className="flex rounded overflow-hidden border border-surface-0 text-xs">
          <button
            className={`px-2.5 py-0.5 transition-colors ${
              viewMode === 'preview'
                ? 'bg-ctp-surface0 text-ctp-text'
                : 'bg-transparent text-ctp-subtext0 hover:text-ctp-text'
            }`}
            onClick={() => setViewMode('preview')}
          >
            Preview
          </button>
          <button
            className={`px-2.5 py-0.5 transition-colors ${
              viewMode === 'source'
                ? 'bg-ctp-surface0 text-ctp-text'
                : 'bg-transparent text-ctp-subtext0 hover:text-ctp-text'
            }`}
            onClick={() => setViewMode('source')}
          >
            Source
          </button>
        </div>
        <button
          onClick={() => setShowSendDialog(true)}
          className="ml-auto px-2.5 py-0.5 text-xs rounded border border-surface-0
            text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0
            transition-colors cursor-pointer flex-shrink-0"
        >
          Send to Agent
        </button>
        <span className="text-xs text-ctp-subtext0 truncate">{selectedNote}</span>
      </div>
      {viewMode === 'preview' ? (
        <div className="flex-1 overflow-auto p-6">
          <MarkdownPreview content={content} />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <MonacoCodeEditor
            key={selectedNote}
            filePath={selectedNote}
            initialContent={content}
            onDirtyChange={handleDirtyChange}
            onSave={handleSave}
          />
        </div>
      )}
      {showSendDialog && selectedNote && content !== null && (
        <SendToAgentDialog
          notePath={selectedNote}
          noteContent={content}
          onClose={() => setShowSendDialog(false)}
        />
      )}
    </div>
  );
}
