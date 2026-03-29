import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('browser plugin manifest', () => {
  it('passes manifest validation', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('has correct id', () => {
    expect(manifest.id).toBe('browser');
  });

  it('is dual-scoped', () => {
    expect(manifest.scope).toBe('dual');
  });

  it('targets API v0.8', () => {
    expect(manifest.engine.api).toBe(0.8);
  });

  it('declares required permissions including canvas and projects', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['commands', 'storage', 'canvas', 'widgets', 'projects']),
    );
    expect(manifest.permissions).toHaveLength(5);
  });

  it('does not declare annex permission', () => {
    expect(manifest.permissions).not.toContain('annex');
  });

  it('contributes tab.title', () => {
    expect(manifest.contributes!.tab!.title).toBe('Browser');
  });

  it('contributes a sidebar-content layout tab', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.layout).toBe('sidebar-content');
    expect(manifest.contributes!.tab!.label).toBe('Browser');
  });

  it('has a tab icon (SVG string)', () => {
    expect(manifest.contributes!.tab!.icon).toContain('<svg');
  });

  it('declares a webview canvas widget', () => {
    const widgets = manifest.contributes?.canvasWidgets;
    expect(widgets).toBeDefined();
    expect(widgets).toHaveLength(1);
    const webview = widgets![0];
    expect(webview.id).toBe('webview');
    expect(webview.label).toBe('Browser');
    expect(webview.defaultSize).toEqual({ width: 640, height: 480 });
    expect(webview.metadataKeys).toEqual(['url']);
  });

  it('contributes help topics', () => {
    expect(manifest.contributes?.help).toBeDefined();
    expect(manifest.contributes!.help!.topics).toBeDefined();
    expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
  });

  it('contributes reload and devtools commands', () => {
    const cmds = manifest.contributes?.commands;
    expect(cmds).toBeDefined();
    expect(cmds!.find((c) => c.id === 'reload')).toBeDefined();
    expect(cmds!.find((c) => c.id === 'devtools')).toBeDefined();
  });

  it('declares allowLocalhost setting', () => {
    const settings = manifest.contributes?.settings;
    expect(settings).toBeDefined();
    const localhostSetting = settings!.find((s) => s.key === 'allowLocalhost');
    expect(localhostSetting).toBeDefined();
    expect(localhostSetting!.type).toBe('boolean');
    expect(localhostSetting!.default).toBe(false);
  });

  it('declares allowFileProtocol setting', () => {
    const settings = manifest.contributes?.settings;
    expect(settings).toBeDefined();
    const fileSetting = settings!.find((s) => s.key === 'allowFileProtocol');
    expect(fileSetting).toBeDefined();
    expect(fileSetting!.type).toBe('boolean');
    expect(fileSetting!.default).toBe(false);
  });

  it('uses declarative settings panel', () => {
    expect(manifest.settingsPanel).toBe('declarative');
  });

  it('does not contribute a rail item (dual but has tab)', () => {
    // dual-scoped plugins can have railItem; browser uses tab
    expect(manifest.contributes?.railItem).toBeUndefined();
  });
});
