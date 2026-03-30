import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for annex UI fixes:
 * (a) Pause overlay covers entire canvas workspace, not individual cards
 * (b) Wires re-render after annex wake via remote agent tracking
 */

const CANVAS_VIEW_PATH = path.resolve(__dirname, 'CanvasView.tsx');
const CANVAS_WORKSPACE_PATH = path.resolve(__dirname, 'CanvasWorkspace.tsx');

describe('annex UI fixes', () => {
  // ─── Fix A: Pause overlay on full canvas ─────────────────────────

  describe('pause overlay covers entire canvas workspace', () => {
    it('CanvasWorkspace renders the satellite paused overlay', () => {
      const source = fs.readFileSync(CANVAS_WORKSPACE_PATH, 'utf-8');
      // Must import annexClientStore for satellite pause state
      expect(source).toContain('useAnnexClientStore');
      // Must compute isAnySatellitePaused from satellitePaused state
      expect(source).toContain('isAnySatellitePaused');
      expect(source).toContain('satellitePaused');
      // Must render the overlay with data-testid
      expect(source).toContain('canvas-satellite-paused-overlay');
    });

    it('CanvasView no longer renders per-card paused overlay', () => {
      const source = fs.readFileSync(CANVAS_VIEW_PATH, 'utf-8');
      // Must NOT contain per-card overlay
      expect(source).not.toContain('canvas-satellite-paused-overlay');
      // Must NOT import annexClientStore
      expect(source).not.toContain('useAnnexClientStore');
      // Must NOT reference satellite pause variables
      expect(source).not.toContain('isSatellitePaused');
    });

    it('overlay uses absolute inset-0 positioning for full canvas coverage', () => {
      const source = fs.readFileSync(CANVAS_WORKSPACE_PATH, 'utf-8');
      // The overlay must be absolutely positioned over the entire workspace
      expect(source).toMatch(/absolute\s+inset-0/);
      // The overlay must have a high z-index to sit above canvas content
      expect(source).toContain('z-[9998]');
    });

    it('overlay renders Session paused message', () => {
      const source = fs.readFileSync(CANVAS_WORKSPACE_PATH, 'utf-8');
      expect(source).toContain('Session paused');
      expect(source).toContain('satellite has paused remote control');
    });
  });

  // ─── Fix B: Wire re-render after annex wake ──────────────────────

  describe('wires re-render after annex wake', () => {
    it('CanvasWorkspace includes remote agents in sleeping agent tracking', () => {
      const source = fs.readFileSync(CANVAS_WORKSPACE_PATH, 'utf-8');
      // Must import remoteProjectStore
      expect(source).toContain('useRemoteProjectStore');
      // Must subscribe to remoteAgents for reactive updates
      expect(source).toContain('remoteAgents');
    });

    it('sleepingAgentIds computation includes remote agent entries', () => {
      const source = fs.readFileSync(CANVAS_WORKSPACE_PATH, 'utf-8');
      // Must iterate over remoteAgents in the sleepingAgentIds computation
      expect(source).toContain('Object.entries(remoteAgents)');
      // Must include remoteAgents as a dependency of sleepingAgentIds
      expect(source).toMatch(/sleepingAgentIds\s*=\s*useMemo\(/);
      // The dependency array must include remoteAgents
      const sleepingMemoMatch = source.match(
        /sleepingAgentIds\s*=\s*useMemo\(\s*\(\)\s*=>\s*\{[\s\S]*?\},\s*\[([^\]]*)\]/
      );
      expect(sleepingMemoMatch).not.toBeNull();
      expect(sleepingMemoMatch![1]).toContain('remoteAgents');
    });

    it('remote sleeping agents are added to the sleeping set', () => {
      const source = fs.readFileSync(CANVAS_WORKSPACE_PATH, 'utf-8');
      // The remote agent loop must check for sleeping/error status
      // and add the namespaced ID to the sleeping set
      expect(source).toContain("agent.status === 'sleeping'");
      expect(source).toContain("agent.status === 'error'");
      expect(source).toContain('sleeping.add(nsId)');
    });
  });
});
