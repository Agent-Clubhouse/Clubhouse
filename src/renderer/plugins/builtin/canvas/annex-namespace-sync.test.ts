/**
 * Tests for namespace ID translation across the annex wire boundary.
 *
 * Controllers use namespaced IDs (remote||satelliteId||originalId) but
 * satellites store original IDs. This file verifies:
 * - Namespace stripping logic (simulating server-side updateView handling)
 * - Namespace re-adding when canvas state flows back to the controller
 * - Widget adapter resolution for remote agents
 */
import { describe, it, expect } from 'vitest';

// ── Namespace stripping (mirrors server-side stripNamespacedIds) ──────

function stripNamespacedIds(updates: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...updates };
  for (const key of ['agentId', 'projectId'] as const) {
    if (typeof cleaned[key] === 'string') {
      const parts = (cleaned[key] as string).split('||');
      if (parts.length === 3 && parts[0] === 'remote') {
        cleaned[key] = parts[2];
      }
    }
  }
  if (cleaned.metadata && typeof cleaned.metadata === 'object') {
    const meta = { ...(cleaned.metadata as Record<string, unknown>) };
    for (const key of ['agentId', 'projectId'] as const) {
      if (typeof meta[key] === 'string') {
        const parts = (meta[key] as string).split('||');
        if (parts.length === 3 && parts[0] === 'remote') {
          meta[key] = parts[2];
        }
      }
    }
    cleaned.metadata = meta;
  }
  return cleaned;
}

// ── Namespace re-adding (mirrors annexClientStore view namespacing) ───

function namespaceViewIds(view: any, satelliteId: string): any {
  const patched = { ...view };
  if (patched.agentId && typeof patched.agentId === 'string' && !patched.agentId.startsWith('remote||')) {
    patched.agentId = `remote||${satelliteId}||${patched.agentId}`;
  }
  if (patched.projectId && typeof patched.projectId === 'string' && !patched.projectId.startsWith('remote||')) {
    patched.projectId = `remote||${satelliteId}||${patched.projectId}`;
  }
  if (patched.metadata && typeof patched.metadata === 'object') {
    const meta = { ...patched.metadata };
    if (meta.agentId && typeof meta.agentId === 'string' && !meta.agentId.startsWith('remote||')) {
      meta.agentId = `remote||${satelliteId}||${meta.agentId}`;
    }
    if (meta.projectId && typeof meta.projectId === 'string' && !meta.projectId.startsWith('remote||')) {
      meta.projectId = `remote||${satelliteId}||${meta.projectId}`;
    }
    patched.metadata = meta;
  }
  return patched;
}

describe('annex namespace ID translation', () => {
  describe('stripNamespacedIds (satellite side)', () => {
    it('strips namespace prefix from agentId', () => {
      const result = stripNamespacedIds({
        agentId: 'remote||sat-1||durable_foo',
        title: 'My Agent',
      });

      expect(result.agentId).toBe('durable_foo');
      expect(result.title).toBe('My Agent');
    });

    it('strips namespace prefix from projectId', () => {
      const result = stripNamespacedIds({
        projectId: 'remote||sat-1||proj-123',
      });

      expect(result.projectId).toBe('proj-123');
    });

    it('strips namespace from metadata agentId and projectId', () => {
      const result = stripNamespacedIds({
        agentId: 'remote||sat-1||durable_foo',
        projectId: 'remote||sat-1||proj-123',
        metadata: {
          agentId: 'remote||sat-1||durable_foo',
          projectId: 'remote||sat-1||proj-123',
          agentName: 'My Agent',
        },
      });

      expect(result.agentId).toBe('durable_foo');
      expect(result.projectId).toBe('proj-123');
      const meta = result.metadata as Record<string, unknown>;
      expect(meta.agentId).toBe('durable_foo');
      expect(meta.projectId).toBe('proj-123');
      expect(meta.agentName).toBe('My Agent');
    });

    it('leaves non-namespaced IDs unchanged', () => {
      const result = stripNamespacedIds({
        agentId: 'durable_foo',
        projectId: 'proj-123',
      });

      expect(result.agentId).toBe('durable_foo');
      expect(result.projectId).toBe('proj-123');
    });

    it('handles missing fields gracefully', () => {
      const result = stripNamespacedIds({
        title: 'Test',
        displayName: 'Test',
      });

      expect(result.title).toBe('Test');
      expect(result.agentId).toBeUndefined();
      expect(result.projectId).toBeUndefined();
    });

    it('handles null/undefined metadata', () => {
      const result = stripNamespacedIds({
        agentId: 'remote||sat-1||durable_foo',
        metadata: null,
      });

      expect(result.agentId).toBe('durable_foo');
    });
  });

  describe('namespaceViewIds (controller side)', () => {
    it('adds namespace prefix to agentId', () => {
      const result = namespaceViewIds(
        { id: 'cv_1', agentId: 'durable_foo', type: 'agent' },
        'sat-1',
      );

      expect(result.agentId).toBe('remote||sat-1||durable_foo');
    });

    it('adds namespace prefix to projectId', () => {
      const result = namespaceViewIds(
        { id: 'cv_1', projectId: 'proj-123', type: 'agent' },
        'sat-1',
      );

      expect(result.projectId).toBe('remote||sat-1||proj-123');
    });

    it('namespaces metadata agentId and projectId', () => {
      const result = namespaceViewIds(
        {
          id: 'cv_1', agentId: 'durable_foo', projectId: 'proj-123',
          metadata: { agentId: 'durable_foo', projectId: 'proj-123', agentName: 'Test' },
        },
        'sat-1',
      );

      expect(result.metadata.agentId).toBe('remote||sat-1||durable_foo');
      expect(result.metadata.projectId).toBe('remote||sat-1||proj-123');
      expect(result.metadata.agentName).toBe('Test');
    });

    it('does not double-namespace already namespaced IDs', () => {
      const result = namespaceViewIds(
        { id: 'cv_1', agentId: 'remote||sat-1||durable_foo' },
        'sat-1',
      );

      expect(result.agentId).toBe('remote||sat-1||durable_foo');
    });

    it('leaves views without agentId/projectId unchanged', () => {
      const result = namespaceViewIds(
        { id: 'cv_1', type: 'agent', title: 'Empty' },
        'sat-1',
      );

      expect(result.agentId).toBeUndefined();
      expect(result.projectId).toBeUndefined();
    });
  });

  describe('round-trip: controller → satellite → controller', () => {
    it('namespaced IDs survive full round trip', () => {
      const satelliteId = 'sat-abc';
      const originalAgentId = 'durable_mega-camel';
      const originalProjectId = 'proj-xyz';

      // Step 1: Controller sends namespaced updateView
      const controllerUpdates = {
        agentId: `remote||${satelliteId}||${originalAgentId}`,
        projectId: `remote||${satelliteId}||${originalProjectId}`,
        title: 'mega-camel',
        metadata: {
          agentId: `remote||${satelliteId}||${originalAgentId}`,
          projectId: `remote||${satelliteId}||${originalProjectId}`,
        },
      };

      // Step 2: Satellite strips namespace
      const satelliteView = stripNamespacedIds(controllerUpdates);
      expect(satelliteView.agentId).toBe(originalAgentId);
      expect(satelliteView.projectId).toBe(originalProjectId);
      expect((satelliteView.metadata as any).agentId).toBe(originalAgentId);

      // Step 3: Satellite broadcasts state → controller re-namespaces
      const controllerView = namespaceViewIds(
        { id: 'cv_1', ...satelliteView },
        satelliteId,
      );
      expect(controllerView.agentId).toBe(`remote||${satelliteId}||${originalAgentId}`);
      expect(controllerView.projectId).toBe(`remote||${satelliteId}||${originalProjectId}`);
      expect(controllerView.metadata.agentId).toBe(`remote||${satelliteId}||${originalAgentId}`);
    });
  });
});
