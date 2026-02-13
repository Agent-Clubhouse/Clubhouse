import { describe, it, expect, vi } from 'vitest';

vi.mock('../features/notes/NotesTree', () => ({ NotesTree: () => null }));
vi.mock('../features/notes/NoteEditor', () => ({ NoteEditor: () => null }));

import { notesPlugin } from './notes-plugin';

describe('notes plugin', () => {
  it('has correct id and label', () => {
    expect(notesPlugin.id).toBe('notes');
    expect(notesPlugin.label).toBe('Notes');
  });

  it('provides SidebarPanel and MainPanel', () => {
    expect(notesPlugin.SidebarPanel).toBeDefined();
    expect(notesPlugin.MainPanel).toBeDefined();
  });

  it('is not fullWidth', () => {
    expect(notesPlugin.fullWidth).toBeFalsy();
  });
});
