import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('wiki plugin manifest', () => {
  it('passes manifest validation', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('has correct id', () => {
    expect(manifest.id).toBe('wiki');
  });

  it('is project-scoped', () => {
    expect(manifest.scope).toBe('project');
  });

  it('targets API v0.5', () => {
    expect(manifest.engine.api).toBe(0.5);
  });

  it('declares exactly 8 permissions', () => {
    expect(manifest.permissions).toHaveLength(8);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        'files', 'files.external', 'commands', 'notifications',
        'agents', 'navigation', 'storage', 'widgets',
      ]),
    );
  });

  it('includes files.external permission', () => {
    expect(manifest.permissions).toContain('files.external');
  });

  it('declares externalRoots with correct shape', () => {
    expect(manifest.externalRoots).toBeDefined();
    expect(manifest.externalRoots).toHaveLength(1);
    expect(manifest.externalRoots![0]).toEqual({
      settingKey: 'wikiPath',
      root: 'wiki',
    });
  });

  it('externalRoots settingKey references an existing setting', () => {
    const settingKeys = manifest.contributes?.settings?.map((s) => s.key) ?? [];
    expect(settingKeys).toContain(manifest.externalRoots![0].settingKey);
  });

  it('contributes a tab with sidebar-content layout', () => {
    expect(manifest.contributes?.tab?.label).toBe('Wiki');
    expect(manifest.contributes?.tab?.layout).toBe('sidebar-content');
  });

  it('contributes a refresh command', () => {
    expect(manifest.contributes?.commands).toContainEqual(
      expect.objectContaining({ id: 'refresh' }),
    );
  });

  it('contributes wikiPath and showHiddenFiles settings', () => {
    expect(manifest.contributes?.settings).toContainEqual(
      expect.objectContaining({ key: 'wikiPath', type: 'directory' }),
    );
    expect(manifest.contributes?.settings).toContainEqual(
      expect.objectContaining({ key: 'showHiddenFiles', type: 'boolean' }),
    );
  });

  it('contributes help topics', () => {
    expect(manifest.contributes?.help?.topics).toBeDefined();
    expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
    expect(manifest.contributes!.help!.topics![0].id).toBe('wiki-browser');
  });

  it('uses declarative settings panel', () => {
    expect(manifest.settingsPanel).toBe('declarative');
  });

  it('has a tab icon (SVG string)', () => {
    expect(manifest.contributes!.tab!.icon).toContain('<svg');
  });
});
