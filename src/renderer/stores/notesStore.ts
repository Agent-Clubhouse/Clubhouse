import { create } from 'zustand';

interface NoteEntry {
  name: string;
  path: string;
}

interface NotesState {
  notes: NoteEntry[];
  selectedNote: string | null;
  loadNotes: (projectPath: string) => Promise<void>;
  setSelectedNote: (notePath: string | null) => void;
  createNote: (projectPath: string, title: string) => Promise<void>;
  deleteNote: (notePath: string, projectPath: string) => Promise<void>;
  renameNote: (oldPath: string, newTitle: string, projectPath: string) => Promise<void>;
}

function notesDir(projectPath: string): string {
  return `${projectPath}/.clubhouse/notes`;
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  selectedNote: null,

  loadNotes: async (projectPath) => {
    const dir = notesDir(projectPath);
    await window.clubhouse.file.mkdir(dir);
    try {
      const tree = await window.clubhouse.file.readTree(dir);
      const notes: NoteEntry[] = tree
        .filter((n: { name: string; isDirectory: boolean }) => !n.isDirectory && n.name.endsWith('.md'))
        .map((n: { name: string; path: string }) => ({ name: n.name.replace(/\.md$/, ''), path: n.path }));
      set({ notes });
    } catch {
      set({ notes: [] });
    }
  },

  setSelectedNote: (notePath) => set({ selectedNote: notePath }),

  createNote: async (projectPath, title) => {
    const dir = notesDir(projectPath);
    await window.clubhouse.file.mkdir(dir);
    const filePath = `${dir}/${title}.md`;
    await window.clubhouse.file.write(filePath, `# ${title}\n`);
    await get().loadNotes(projectPath);
    set({ selectedNote: filePath });
  },

  deleteNote: async (notePath, projectPath) => {
    await window.clubhouse.file.delete(notePath);
    const { selectedNote } = get();
    if (selectedNote === notePath) {
      set({ selectedNote: null });
    }
    await get().loadNotes(projectPath);
  },

  renameNote: async (oldPath, newTitle, projectPath) => {
    const content = await window.clubhouse.file.read(oldPath);
    const dir = notesDir(projectPath);
    const newPath = `${dir}/${newTitle}.md`;
    await window.clubhouse.file.write(newPath, content);
    await window.clubhouse.file.delete(oldPath);
    const { selectedNote } = get();
    if (selectedNote === oldPath) {
      set({ selectedNote: newPath });
    }
    await get().loadNotes(projectPath);
  },
}));
