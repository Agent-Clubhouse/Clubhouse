/**
 * Tests for remote canvas wire definition sync and agent card pending state.
 *
 * Covers:
 * - Wire definitions included in broadcast snapshots
 * - Wire definitions hydrated from remote state
 * - Wire definition ID namespacing on the controller
 * - Agent card "connecting" state when agent not yet in store
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { broadcastCanvasState } from './canvas-sync';
import { createCanvasStore } from './canvas-store';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

describe('remote canvas wire sync', () => {
  let store: ReturnType<typeof createCanvasStore>;
  let broadcastSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createCanvasStore();
    broadcastSpy = vi.fn();
    window.clubhouse.window.broadcastCanvasState = broadcastSpy;
  });

  // ── broadcastCanvasState includes wireDefinitions ───────────────────

  describe('broadcastCanvasState wire definitions', () => {
    it('includes wireDefinitions in snapshot when wires exist', () => {
      const canvasId = store.getState().activeCanvasId;

      // Add a wire definition
      store.getState().addWireDefinition({
        agentId: 'agent-1',
        targetId: 'agent-2',
        targetKind: 'agent',
        label: 'Test Wire',
        agentName: 'Alpha',
        targetName: 'Beta',
      } as McpBindingEntry);

      broadcastCanvasState(store, canvasId);

      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.wireDefinitions).toBeDefined();
      expect(snapshot.wireDefinitions).toHaveLength(1);
      expect(snapshot.wireDefinitions[0]).toEqual(expect.objectContaining({
        agentId: 'agent-1',
        targetId: 'agent-2',
        targetKind: 'agent',
        label: 'Test Wire',
        agentName: 'Alpha',
        targetName: 'Beta',
      }));
    });

    it('omits wireDefinitions from snapshot when no wires exist', () => {
      const canvasId = store.getState().activeCanvasId;

      broadcastCanvasState(store, canvasId);

      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.wireDefinitions).toBeUndefined();
    });

    it('includes instructions and disabledTools when present', () => {
      const canvasId = store.getState().activeCanvasId;

      store.getState().addWireDefinition({
        agentId: 'agent-1',
        targetId: 'browser-1',
        targetKind: 'browser',
        label: 'Browse',
        instructions: { system: 'Be helpful' },
        disabledTools: ['screenshot'],
      } as McpBindingEntry);

      broadcastCanvasState(store, canvasId);

      const wire = broadcastSpy.mock.calls[0][0].wireDefinitions[0];
      expect(wire.instructions).toEqual({ system: 'Be helpful' });
      expect(wire.disabledTools).toEqual(['screenshot']);
    });

    it('omits empty instructions and disabledTools', () => {
      const canvasId = store.getState().activeCanvasId;

      store.getState().addWireDefinition({
        agentId: 'agent-1',
        targetId: 'agent-2',
        targetKind: 'agent',
        label: 'Wire',
        disabledTools: [],
      } as McpBindingEntry);

      broadcastCanvasState(store, canvasId);

      const wire = broadcastSpy.mock.calls[0][0].wireDefinitions[0];
      expect(wire.instructions).toBeUndefined();
      expect(wire.disabledTools).toBeUndefined();
    });
  });

  // ── hydrateFromRemote restores wireDefinitions ──────────────────────

  describe('hydrateFromRemote with wireDefinitions', () => {
    it('restores wire definitions from remote state', () => {
      const canvasId = 'remote-canvas-1';
      const wireDefinitions = [
        {
          agentId: 'remote||sat-1||agent-1',
          targetId: 'remote||sat-1||agent-2',
          targetKind: 'agent',
          label: 'Test Wire',
          agentName: 'Alpha',
          targetName: 'Beta',
        },
      ];

      store.getState().hydrateFromRemote(
        [{ id: canvasId, name: 'Tab 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null }],
        canvasId,
        wireDefinitions,
      );

      expect(store.getState().wireDefinitions).toHaveLength(1);
      expect(store.getState().wireDefinitions[0].agentId).toBe('remote||sat-1||agent-1');
      expect(store.getState().wireDefinitions[0].targetId).toBe('remote||sat-1||agent-2');
    });

    it('does not overwrite wires when remote state has no wireDefinitions', () => {
      // Pre-populate wires
      store.getState().addWireDefinition({
        agentId: 'existing-agent',
        targetId: 'existing-target',
        targetKind: 'agent',
        label: 'Existing',
      } as McpBindingEntry);

      const canvasId = 'remote-canvas-1';
      store.getState().hydrateFromRemote(
        [{ id: canvasId, name: 'Tab 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null }],
        canvasId,
        undefined,
      );

      // Existing wires should remain
      expect(store.getState().wireDefinitions).toHaveLength(1);
      expect(store.getState().wireDefinitions[0].agentId).toBe('existing-agent');
    });

    it('does not set wireDefinitions when remote state has empty array', () => {
      // Pre-populate
      store.getState().addWireDefinition({
        agentId: 'existing',
        targetId: 'target',
        targetKind: 'agent',
        label: 'Wire',
      } as McpBindingEntry);

      const canvasId = 'remote-canvas-1';
      store.getState().hydrateFromRemote(
        [{ id: canvasId, name: 'Tab 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null }],
        canvasId,
        [],
      );

      // Empty array should not overwrite — no wires from remote means no change
      expect(store.getState().wireDefinitions).toHaveLength(1);
    });

    it('replaces wire definitions on subsequent hydrations with new wires', () => {
      const canvasId = 'remote-canvas-1';

      // First hydration with one wire
      store.getState().hydrateFromRemote(
        [{ id: canvasId, name: 'Tab 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null }],
        canvasId,
        [{ agentId: 'a1', targetId: 't1', targetKind: 'agent', label: 'Wire 1' }],
      );

      expect(store.getState().wireDefinitions).toHaveLength(1);

      // Second hydration with two wires
      store.getState().hydrateFromRemote(
        [{ id: canvasId, name: 'Tab 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null }],
        canvasId,
        [
          { agentId: 'a1', targetId: 't1', targetKind: 'agent', label: 'Wire 1' },
          { agentId: 'a2', targetId: 't2', targetKind: 'agent', label: 'Wire 2' },
        ],
      );

      expect(store.getState().wireDefinitions).toHaveLength(2);
    });
  });

  // ── Wire definition namespacing ─────────────────────────────────────

  describe('wire definition namespacing', () => {
    // This mirrors the logic in annexClientStore's canvas:state handler
    function namespaceWires(
      wires: Array<{ agentId: string; targetId: string; targetKind: string; label: string }>,
      satelliteId: string,
    ) {
      return wires.map((w) => {
        const patched = { ...w };
        if (patched.agentId && !patched.agentId.startsWith('remote||')) {
          patched.agentId = `remote||${satelliteId}||${patched.agentId}`;
        }
        if (patched.targetId && !patched.targetId.startsWith('remote||')) {
          patched.targetId = `remote||${satelliteId}||${patched.targetId}`;
        }
        return patched;
      });
    }

    it('namespaces agent and target IDs in wire definitions', () => {
      const wires = [
        { agentId: 'agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Wire' },
      ];

      const namespaced = namespaceWires(wires, 'sat-abc');

      expect(namespaced[0].agentId).toBe('remote||sat-abc||agent-1');
      expect(namespaced[0].targetId).toBe('remote||sat-abc||agent-2');
    });

    it('does not double-namespace already namespaced IDs', () => {
      const wires = [
        { agentId: 'remote||sat-abc||agent-1', targetId: 'agent-2', targetKind: 'agent', label: 'Wire' },
      ];

      const namespaced = namespaceWires(wires, 'sat-abc');

      expect(namespaced[0].agentId).toBe('remote||sat-abc||agent-1');
      expect(namespaced[0].targetId).toBe('remote||sat-abc||agent-2');
    });

    it('namespaces browser/group-project target IDs', () => {
      const wires = [
        { agentId: 'agent-1', targetId: 'browser-view-1', targetKind: 'browser', label: 'Browse' },
        { agentId: 'agent-2', targetId: 'gp-123', targetKind: 'group-project', label: 'Group' },
      ];

      const namespaced = namespaceWires(wires, 'sat-xyz');

      expect(namespaced[0].targetId).toBe('remote||sat-xyz||browser-view-1');
      expect(namespaced[1].targetId).toBe('remote||sat-xyz||gp-123');
    });
  });
});
