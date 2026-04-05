import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural tests for the satellite pause overlay in CanvasWorkspace.
 *
 * Verifies that the overlay only appears for remote canvases — local canvases
 * should never show the paused overlay even when a satellite is paused.
 */
describe('Canvas paused overlay — project-aware detection', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, 'CanvasWorkspace.tsx'),
    'utf-8',
  );

  it('imports isRemoteProjectId and parseNamespacedId for project-aware check', () => {
    expect(source).toContain('isRemoteProjectId');
    expect(source).toContain('parseNamespacedId');
  });

  it('reads activeProjectId from project store', () => {
    expect(source).toContain('activeProjectId');
    expect(source).toContain('useProjectStore');
  });

  it('checks isRemoteProjectId before showing overlay', () => {
    // The pause detection block must gate on isRemoteProjectId
    const pauseBlock = source.slice(
      source.indexOf('Satellite pause detection'),
      source.indexOf('const handleWireClick'),
    );
    expect(pauseBlock).toContain('isRemoteProjectId(activeProjectId)');
  });

  it('checks specific satellite paused state via parseNamespacedId', () => {
    const pauseBlock = source.slice(
      source.indexOf('Satellite pause detection'),
      source.indexOf('const handleWireClick'),
    );
    expect(pauseBlock).toContain('parseNamespacedId(activeProjectId)');
    expect(pauseBlock).toContain('satellitePaused[parsed.satelliteId]');
  });

  it('returns false for local projects (no blanket isAnySatellitePaused)', () => {
    const pauseBlock = source.slice(
      source.indexOf('Satellite pause detection'),
      source.indexOf('const handleWireClick'),
    );
    // Must NOT use Object.values(satellitePaused).some(Boolean) — that was the bug
    expect(pauseBlock).not.toContain('Object.values(satellitePaused).some');
    // Must return false when activeProjectId is null or local
    expect(pauseBlock).toContain('return false');
  });
});
