import { describe, it, expect, vi } from 'vitest';

// Mock components to avoid browser dependencies (monaco-editor, etc.)
vi.mock('../features/files/FileTree', () => ({ FileTree: () => null }));
vi.mock('../features/files/FileViewer', () => ({ FileViewer: () => null }));

import { filesPlugin } from './files-plugin';

describe('files plugin', () => {
  it('has correct id and label', () => {
    expect(filesPlugin.id).toBe('files');
    expect(filesPlugin.label).toBe('Files');
  });

  it('provides SidebarPanel and MainPanel', () => {
    expect(filesPlugin.SidebarPanel).toBeDefined();
    expect(filesPlugin.MainPanel).toBeDefined();
  });

  it('is not fullWidth', () => {
    expect(filesPlugin.fullWidth).toBeFalsy();
  });
});
