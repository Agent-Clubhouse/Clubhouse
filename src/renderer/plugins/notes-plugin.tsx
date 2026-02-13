import { NotesTree } from '../features/notes/NotesTree';
import { NoteEditor } from '../features/notes/NoteEditor';
import { PluginDefinition } from './types';

export const notesPlugin: PluginDefinition = {
  id: 'notes',
  label: 'Notes',
  icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  SidebarPanel: NotesTree,
  MainPanel: NoteEditor,
};
