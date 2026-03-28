import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('canvas manifest', () => {
  it('passes validateManifest()', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('has id "canvas"', () => {
    expect(manifest.id).toBe('canvas');
  });

  it('has scope "dual"', () => {
    expect(manifest.scope).toBe('dual');
  });

  it('targets engine.api 0.9', () => {
    expect(manifest.engine.api).toBe(0.9);
  });

  it('contributes tab.title and railItem.title', () => {
    expect(manifest.contributes!.tab!.title).toBe('Canvas');
    expect(manifest.contributes!.railItem!.title).toBe('Canvas');
  });

  it('declares required permissions', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        'commands', 'storage', 'agents', 'projects',
        'widgets', 'navigation', 'files',
      ]),
    );
    // 7 base permissions
    expect(manifest.permissions!.length).toBeGreaterThanOrEqual(7);
  });

  it('contributes a tab with label and full layout', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.label).toBe('Canvas');
    expect(manifest.contributes!.tab!.layout).toBe('full');
  });

  it('contributes a railItem with label and top position', () => {
    expect(manifest.contributes?.railItem).toBeDefined();
    expect(manifest.contributes!.railItem!.label).toBe('Canvas');
    expect(manifest.contributes!.railItem!.position).toBe('top');
  });

  it('contributes commands including reset-viewport with defaultBinding', () => {
    const cmds = manifest.contributes!.commands!;
    expect(cmds).toHaveLength(5);
    const resetCmd = cmds.find((c) => c.id === 'reset-viewport');
    expect(resetCmd).toBeDefined();
    expect(resetCmd!.defaultBinding).toBe('Meta+Shift+0');
  });

  it('contributes project-local storage scope', () => {
    expect(manifest.contributes?.storage).toBeDefined();
    expect(manifest.contributes!.storage!.scope).toBe('project-local');
  });

  it('contributes cross-project-canvas boolean setting with default true', () => {
    const setting = manifest.contributes!.settings!.find((s) => s.key === 'cross-project-canvas');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('boolean');
    expect(setting!.default).toBe(true);
  });

  it('contributes bidirectional-wires boolean setting with default false', () => {
    const setting = manifest.contributes!.settings!.find((s) => s.key === 'bidirectional-wires');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('boolean');
    expect(setting!.default).toBe(false);
  });

  it('uses declarative settings panel', () => {
    expect(manifest.settingsPanel).toBe('declarative');
  });
});
