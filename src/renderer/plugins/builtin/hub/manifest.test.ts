import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('hub manifest', () => {
  it('passes validateManifest()', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('has id "hub"', () => {
    expect(manifest.id).toBe('hub');
  });

  it('has scope "dual"', () => {
    expect(manifest.scope).toBe('dual');
  });

  it('targets engine.api 0.5', () => {
    expect(manifest.engine.api).toBe(0.5);
  });

  it('declares required permissions', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        'commands', 'storage', 'agents', 'projects',
        'widgets', 'navigation', 'notifications',
      ]),
    );
    expect(manifest.permissions).toHaveLength(7);
  });

  it('contributes help topics', () => {
    expect(manifest.contributes?.help).toBeDefined();
    expect(manifest.contributes!.help!.topics).toBeDefined();
    expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
  });

  it('contributes a tab with label and full layout', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.label).toBe('Hub');
    expect(manifest.contributes!.tab!.layout).toBe('full');
  });

  it('contributes a railItem with label and top position', () => {
    expect(manifest.contributes?.railItem).toBeDefined();
    expect(manifest.contributes!.railItem!.label).toBe('Hub');
    expect(manifest.contributes!.railItem!.position).toBe('top');
  });

  it('contributes split-pane command', () => {
    expect(manifest.contributes?.commands).toBeDefined();
    const cmds = manifest.contributes!.commands!;
    expect(cmds.some((c) => c.id === 'split-pane')).toBe(true);
  });

  it('contributes global storage scope', () => {
    expect(manifest.contributes?.storage).toBeDefined();
    expect(manifest.contributes!.storage!.scope).toBe('global');
  });

  it('contributes cross-project-hub boolean setting with default true', () => {
    expect(manifest.contributes?.settings).toBeDefined();
    const setting = manifest.contributes!.settings!.find((s) => s.key === 'cross-project-hub');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('boolean');
    expect(setting!.default).toBe(true);
  });

  it('uses declarative settings panel', () => {
    expect(manifest.settingsPanel).toBe('declarative');
  });
});
