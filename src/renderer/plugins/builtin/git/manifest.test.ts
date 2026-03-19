import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('git plugin manifest', () => {
  it('passes manifest validation', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('has correct id', () => {
    expect(manifest.id).toBe('git');
  });

  it('is project-scoped', () => {
    expect(manifest.scope).toBe('project');
  });

  it('targets API v0.8', () => {
    expect(manifest.engine.api).toBe(0.8);
  });

  it('declares required permissions including canvas', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['git', 'files', 'commands', 'notifications', 'storage', 'canvas']),
    );
    expect(manifest.permissions).toHaveLength(6);
  });

  it('contributes tab.title', () => {
    expect(manifest.contributes!.tab!.title).toBe('Git');
  });

  it('declares a git-status canvas widget', () => {
    const widgets = manifest.contributes?.canvasWidgets;
    expect(widgets).toBeDefined();
    expect(widgets).toHaveLength(1);
    const widget = widgets![0];
    expect(widget.id).toBe('git-status');
    expect(widget.label).toBe('Git Status');
    expect(widget.defaultSize).toEqual({ width: 400, height: 360 });
    expect(widget.metadataKeys).toEqual(['projectId', 'worktreePath']);
  });

  it('contributes help topics', () => {
    expect(manifest.contributes?.help).toBeDefined();
    expect(manifest.contributes!.help!.topics).toBeDefined();
    expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
  });

  it('contributes a sidebar-content layout tab', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.layout).toBe('sidebar-content');
    expect(manifest.contributes!.tab!.label).toBe('Git');
  });

  it('contributes a refresh command with defaultBinding', () => {
    const cmds = manifest.contributes?.commands;
    expect(cmds).toBeDefined();
    const refresh = cmds!.find((c) => c.id === 'refresh');
    expect(refresh).toBeDefined();
    expect(refresh!.defaultBinding).toBe('Meta+Shift+G');
  });

  it('has a tab icon (SVG string)', () => {
    expect(manifest.contributes!.tab!.icon).toContain('<svg');
  });

  it('does not contribute a rail item (project-scoped only)', () => {
    expect(manifest.contributes?.railItem).toBeUndefined();
  });
});
