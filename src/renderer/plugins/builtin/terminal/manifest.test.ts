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

  it('targets API v0.2', () => {
    expect(manifest.engine.api).toBe(0.2);
  });

  it('contributes a full-layout tab', () => {
    expect(manifest.contributes?.tab).toBeDefined();
    expect(manifest.contributes!.tab!.layout).toBe('full');
    expect(manifest.contributes!.tab!.label).toBe('Terminal');
  });

  it('contributes a restart command', () => {
    const cmds = manifest.contributes?.commands;
    expect(cmds).toBeDefined();
    expect(cmds!.some((c) => c.id === 'restart')).toBe(true);
  });

  it('has a tab icon (SVG string)', () => {
    expect(manifest.contributes!.tab!.icon).toContain('<svg');
  });

  it('does not contribute a rail item (project-scoped only)', () => {
    expect(manifest.contributes?.railItem).toBeUndefined();
  });
});
