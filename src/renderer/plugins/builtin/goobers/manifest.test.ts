import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('goobers manifest', () => {
  it('passes validateManifest()', () => {
    const result = validateManifest(manifest);
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('has id "goobers"', () => {
    expect(manifest.id).toBe('goobers');
  });

  it('has scope "app"', () => {
    expect(manifest.scope).toBe('app');
  });

  it('targets engine.api >= 0.5', () => {
    expect(manifest.engine.api).toBeGreaterThanOrEqual(0.5);
  });

  it('does not contribute a tab (app scope forbids it)', () => {
    expect(manifest.contributes?.tab).toBeUndefined();
  });

  it('contributes a railItem', () => {
    expect(manifest.contributes?.railItem).toBeDefined();
    expect(manifest.contributes!.railItem!.label).toBe('Goobers');
  });

  it('rail icon contains an inline <svg>', () => {
    expect(manifest.contributes!.railItem!.icon).toContain('<svg');
  });

  it('declares exactly the Phase 1 permission set', () => {
    expect([...manifest.permissions].sort()).toEqual(['commands', 'logging', 'navigation', 'storage']);
  });

  it('does not request badges permission (Phase 2, D26)', () => {
    expect(manifest.permissions).not.toContain('badges');
  });

  it('does not request notifications permission (Phase 2, D26)', () => {
    expect(manifest.permissions).not.toContain('notifications');
  });

  it('does not request process permission', () => {
    expect(manifest.permissions).not.toContain('process');
  });

  it('does not request files permission', () => {
    expect(manifest.permissions).not.toContain('files');
  });

  it('does not request files.external permission', () => {
    expect(manifest.permissions).not.toContain('files.external');
  });

  it('does not request terminal permission', () => {
    expect(manifest.permissions).not.toContain('terminal');
  });

  it('contributes exactly the four goobers commands', () => {
    const ids = manifest.contributes!.commands!.map((c) => c.id).sort();
    expect(ids).toEqual(['goobers.open', 'goobers.refresh', 'goobers.start', 'goobers.stop']);
  });

  it('contributes the three mandatory help topics with real prose', () => {
    const topics = manifest.contributes!.help!.topics!;
    const ids = topics.map((t) => t.id).sort();
    expect(ids).toEqual(['goobers-daemon', 'goobers-overview', 'goobers-setup']);
    for (const topic of topics) {
      expect(typeof topic.content).toBe('string');
      expect((topic.content as string).length).toBeGreaterThan(200);
    }
  });

  it('uses declarative settings panel', () => {
    expect(manifest.settingsPanel).toBe('declarative');
  });
});
