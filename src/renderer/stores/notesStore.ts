import { create } from 'zustand';
import { FileNode } from '../../shared/types';

interface NotesState {
  tree: FileNode[];
  selectedNote: string | null;
  loadNotes: (projectPath: string) => Promise<void>;
  setSelectedNote: (notePath: string | null) => void;
  createNote: (projectPath: string, parentDir: string, title: string) => Promise<void>;
  createFolder: (projectPath: string, parentDir: string, folderName: string) => Promise<void>;
  deleteEntry: (entryPath: string, projectPath: string) => Promise<void>;
  renameNote: (oldPath: string, newTitle: string, projectPath: string) => Promise<void>;
}

export function notesDir(projectPath: string): string {
  return `${projectPath}/.clubhouse/notes`;
}

export const useNotesStore = create<NotesState>((set, get) => ({
  tree: [],
  selectedNote: null,

  loadNotes: async (projectPath) => {
    const dir = notesDir(projectPath);
    await window.clubhouse.file.mkdir(dir);
    try {
      const tree = await window.clubhouse.file.readTree(dir);
      set({ tree });
    } catch {
      set({ tree: [] });
    }
  },

  setSelectedNote: (notePath) => set({ selectedNote: notePath }),

  createNote: async (projectPath, parentDir, title) => {
    const filePath = `${parentDir}/${title}.md`;
    await window.clubhouse.file.write(filePath, `# ${title}\n`);
    await get().loadNotes(projectPath);
    set({ selectedNote: filePath });
  },

  createFolder: async (projectPath, parentDir, folderName) => {
    const folderPath = `${parentDir}/${folderName}`;
    await window.clubhouse.file.mkdir(folderPath);
    await get().loadNotes(projectPath);
  },

  deleteEntry: async (entryPath, projectPath) => {
    await window.clubhouse.file.delete(entryPath);
    const { selectedNote } = get();
    if (selectedNote && (selectedNote === entryPath || selectedNote.startsWith(entryPath + '/'))) {
      set({ selectedNote: null });
    }
    await get().loadNotes(projectPath);
  },

  renameNote: async (oldPath, newTitle, projectPath) => {
    const content = await window.clubhouse.file.read(oldPath);
    const dir = oldPath.substring(0, oldPath.lastIndexOf('/'));
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
