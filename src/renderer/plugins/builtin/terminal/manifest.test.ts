import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('terminal plugin manifest', () => {
  it('passes manifest validation', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('has correct id', () => {
    expect(manifest.id).toBe('terminal');
  });

  it('is project-scoped', () => {
    expect(manifest.scope).toBe('project');
  });

  it('targets API v0.8', () => {
    expect(manifest.engine.api).toBe(0.8);
  });

  it('declares required permissions including canvas', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['terminal', 'commands', 'agents', 'canvas', 'annex']),
    );
    expect(manifest.permissions).toHaveLength(5);
  });

  it('contributes tab.title', () => {
    expect(manifest.contributes!.tab!.title).toBe('Terminal');
  });

  it('declares a shell canvas widget', () => {
    const widgets = manifest.contributes?.canvasWidgets;
    expect(widgets).toBeDefined();
    expect(widgets).toHaveLength(1);
    const shell = widgets![0];
    expect(shell.id).toBe('shell');
    expect(shell.label).toBe('Terminal');
    expect(shell.defaultSize).toEqual({ width: 480, height: 360 });
    expect(shell.metadataKeys).toEqual(['projectId', 'cwd']);
  });

  it('contributes help topics', () => {
    expect(manifest.contributes?.help).toBeDefined();
    expect(manifest.contributes!.help!.topics).toBeDefined();
    expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
  });

  it('contributes a sidebar-content layout tab', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.layout).toBe('sidebar-content');
    expect(manifest.contributes!.tab!.label).toBe('Terminal');
  });

  it('contributes a restart command with defaultBinding', () => {
    const cmds = manifest.contributes?.commands;
    expect(cmds).toBeDefined();
    const restart = cmds!.find((c) => c.id === 'restart');
    expect(restart).toBeDefined();
    expect(restart!.defaultBinding).toBe('Meta+Shift+T');
  });

  it('has a tab icon (SVG string)', () => {
    expect(manifest.contributes!.tab!.icon).toContain('<svg');
  });

  it('does not contribute a rail item (project-scoped only)', () => {
    expect(manifest.contributes?.railItem).toBeUndefined();
  });
});
