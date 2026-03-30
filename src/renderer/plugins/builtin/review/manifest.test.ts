import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('review manifest', () => {
  it('passes validateManifest()', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('has id "review"', () => {
    expect(manifest.id).toBe('review');
  });

  it('has scope "dual"', () => {
    expect(manifest.scope).toBe('dual');
  });

  it('targets engine.api 0.8', () => {
    expect(manifest.engine.api).toBe(0.8);
  });

  it('contributes tab with full layout', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.label).toBe('Review');
    expect(manifest.contributes!.tab!.layout).toBe('full');
  });

  it('contributes tab.title and railItem.title', () => {
    expect(manifest.contributes!.tab!.title).toBe('Review');
    expect(manifest.contributes!.railItem!.title).toBe('Review');
  });

  it('contributes railItem with top position', () => {
    expect(manifest.contributes?.railItem).toBeDefined();
    expect(manifest.contributes!.railItem!.label).toBe('Review');
    expect(manifest.contributes!.railItem!.position).toBe('top');
  });

  it('contributes review-prev and review-next commands', () => {
    const cmds = manifest.contributes!.commands!;
    const prev = cmds.find((c) => c.id === 'review-prev');
    const next = cmds.find((c) => c.id === 'review-next');
    expect(prev).toBeDefined();
    expect(prev!.defaultBinding).toBe('Meta+ArrowLeft');
    expect(next).toBeDefined();
    expect(next!.defaultBinding).toBe('Meta+ArrowRight');
  });

  it('contributes include-sleeping boolean setting defaulting to true', () => {
    const setting = manifest.contributes!.settings!.find((s) => s.key === 'include-sleeping');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('boolean');
    expect(setting!.default).toBe(true);
  });

  it('contributes needs-attention-only boolean setting defaulting to false', () => {
    const setting = manifest.contributes!.settings!.find((s) => s.key === 'needs-attention-only');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('boolean');
    expect(setting!.default).toBe(false);
  });

  it('contributes include-remote boolean setting defaulting to true', () => {
    const setting = manifest.contributes!.settings!.find((s) => s.key === 'include-remote');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('boolean');
    expect(setting!.default).toBe(true);
  });

  it('declares required permissions', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['commands', 'agents', 'projects', 'widgets', 'navigation']),
    );
  });

  it('uses declarative settings panel', () => {
    expect(manifest.settingsPanel).toBe('declarative');
  });
});
