import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('files plugin manifest', () => {
  it('passes manifest validation', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('has correct id', () => {
    expect(manifest.id).toBe('files');
  });

  it('is project-scoped', () => {
    expect(manifest.scope).toBe('project');
  });

  it('targets API v0.8', () => {
    expect(manifest.engine.api).toBe(0.8);
  });

  it('declares required permissions including canvas and projects', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['files', 'files.watch', 'git', 'commands', 'notifications', 'storage', 'canvas', 'annex', 'projects']),
    );
    expect(manifest.permissions).toHaveLength(9);
  });

  it('contributes tab.title', () => {
    expect(manifest.contributes!.tab!.title).toBe('Files');
  });

  it('declares a file-viewer canvas widget', () => {
    const widgets = manifest.contributes?.canvasWidgets;
    expect(widgets).toBeDefined();
    expect(widgets).toHaveLength(1);
    const fileViewer = widgets![0];
    expect(fileViewer.id).toBe('file-viewer');
    expect(fileViewer.label).toBe('File Viewer');
    expect(fileViewer.defaultSize).toEqual({ width: 560, height: 480 });
    expect(fileViewer.metadataKeys).toEqual(['projectId', 'filePath', 'rootPath']);
  });

  it('contributes help topics', () => {
    expect(manifest.contributes?.help).toBeDefined();
    expect(manifest.contributes!.help!.topics).toBeDefined();
    expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
  });

  it('contributes a sidebar-content layout tab', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.layout).toBe('sidebar-content');
    expect(manifest.contributes!.tab!.label).toBe('Files');
  });

  it('contributes a refresh command with defaultBinding', () => {
    const cmds = manifest.contributes?.commands;
    expect(cmds).toBeDefined();
    const refresh = cmds!.find((c) => c.id === 'refresh');
    expect(refresh).toBeDefined();
    expect(refresh!.defaultBinding).toBe('Meta+Shift+R');
  });

  it('has a tab icon (SVG string)', () => {
    expect(manifest.contributes!.tab!.icon).toContain('<svg');
  });

  it('does not contribute a rail item (project-scoped only)', () => {
    expect(manifest.contributes?.railItem).toBeUndefined();
  });

  it('uses declarative settings panel', () => {
    expect(manifest.settingsPanel).toBe('declarative');
  });

  it('defaults showHiddenFiles to true', () => {
    const settings = manifest.contributes?.settings;
    expect(settings).toBeDefined();
    const hiddenSetting = settings!.find((s) => s.key === 'showHiddenFiles');
    expect(hiddenSetting).toBeDefined();
    expect(hiddenSetting!.default).toBe(true);
  });
});
