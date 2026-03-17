import { describe, it, expect } from 'vitest';
import { manifest } from './manifest';
import { validateManifest } from '../../manifest-validator';

describe('lounge manifest', () => {
  it('passes validateManifest()', () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('has id "lounge"', () => {
    expect(manifest.id).toBe('lounge');
  });

  it('has scope "app"', () => {
    expect(manifest.scope).toBe('app');
  });

  it('targets engine.api 0.6', () => {
    expect(manifest.engine.api).toBe(0.6);
  });

  it('declares required permissions', () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        'agents', 'projects', 'navigation', 'widgets', 'commands', 'storage',
      ]),
    );
    expect(manifest.permissions).toHaveLength(6);
  });

  it('contributes a railItem with label and top position', () => {
    expect(manifest.contributes?.railItem).toBeDefined();
    expect(manifest.contributes!.railItem!.label).toBe('Lounge');
    expect(manifest.contributes!.railItem!.position).toBe('top');
  });

  it('has a rail icon (SVG string)', () => {
    expect(manifest.contributes!.railItem!.icon).toContain('<svg');
  });

  it('does not contribute a tab (app-scope rail only)', () => {
    expect(manifest.contributes?.tab).toBeUndefined();
  });

  it('contributes global storage scope', () => {
    expect(manifest.contributes?.storage).toBeDefined();
    expect(manifest.contributes!.storage!.scope).toBe('global');
  });

  it('contributes help topics', () => {
    expect(manifest.contributes?.help).toBeDefined();
    expect(manifest.contributes!.help!.topics).toBeDefined();
    expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
  });
});
