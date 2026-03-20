import { describe, it, expect, beforeEach } from 'vitest';
import {
  createViewCounter,
  createView,
  createPluginView,
  queryViews,
} from './canvas-operations';
import {
  deduplicateDisplayName,
} from './canvas-types';
import type { CanvasView, AgentCanvasView, PluginCanvasView } from './canvas-types';

describe('canvas plugin widget support', () => {
  // ── Display name deduplication ──────────────────────────────────────

  describe('deduplicateDisplayName', () => {
    it('returns base name when no duplicates exist', () => {
      expect(deduplicateDisplayName('Agent', [])).toBe('Agent');
      expect(deduplicateDisplayName('Agent', ['Browser', 'Files'])).toBe('Agent');
    });

    it('appends (2) when base name exists', () => {
      expect(deduplicateDisplayName('Agent', ['Agent'])).toBe('Agent (2)');
    });

    it('increments suffix when multiple duplicates exist', () => {
      expect(deduplicateDisplayName('Agent', ['Agent', 'Agent (2)'])).toBe('Agent (3)');
      expect(deduplicateDisplayName('Agent', ['Agent', 'Agent (2)', 'Agent (3)'])).toBe('Agent (4)');
    });

    it('handles gaps in suffix numbers', () => {
      // If (2) is missing but (3) exists, it should use (2)
      expect(deduplicateDisplayName('Agent', ['Agent', 'Agent (3)'])).toBe('Agent (2)');
    });
  });

  // ── createView with displayName ─────────────────────────────────────

  describe('createView with displayName', () => {
    let counter: ReturnType<typeof createViewCounter>;

    beforeEach(() => {
      counter = createViewCounter(0);
    });

    it('generates displayName for agent view', () => {
      const view = createView('agent', { x: 0, y: 0 }, 0, counter);
      expect(view.displayName).toBe('Agent');
      expect(view.metadata).toEqual({});
    });

    it('deduplicates when existing names are provided', () => {
      const view = createView('agent', { x: 0, y: 0 }, 0, counter, ['Agent']);
      expect(view.displayName).toBe('Agent (2)');
    });

    it('throws for plugin type', () => {
      expect(() => createView('plugin', { x: 0, y: 0 }, 0, counter)).toThrow(
        'Use createPluginView()',
      );
    });
  });

  // ── createPluginView ────────────────────────────────────────────────

  describe('createPluginView', () => {
    let counter: ReturnType<typeof createViewCounter>;

    beforeEach(() => {
      counter = createViewCounter(0);
    });

    it('creates a plugin canvas view', () => {
      const view = createPluginView(
        'my-plugin', 'plugin:my-plugin:chart', 'Chart',
        { x: 100, y: 200 }, 0, counter,
      );

      expect(view.type).toBe('plugin');
      expect(view.pluginId).toBe('my-plugin');
      expect(view.pluginWidgetType).toBe('plugin:my-plugin:chart');
      expect(view.title).toBe('Chart');
      expect(view.displayName).toBe('Chart');
      expect(view.metadata).toEqual({});
      expect(view.id).toBe('cv_1');
    });

    it('includes metadata', () => {
      const view = createPluginView(
        'my-plugin', 'plugin:my-plugin:chart', 'Chart',
        { x: 0, y: 0 }, 0, counter, [],
        { dataSource: 'api', chartType: 'bar' },
      );

      expect(view.metadata).toEqual({ dataSource: 'api', chartType: 'bar' });
    });

    it('uses custom default size', () => {
      const view = createPluginView(
        'my-plugin', 'plugin:my-plugin:chart', 'Chart',
        { x: 0, y: 0 }, 0, counter, [], {},
        { width: 600, height: 400 },
      );

      expect(view.size).toEqual({ width: 600, height: 400 });
    });

    it('enforces minimum size', () => {
      const view = createPluginView(
        'my-plugin', 'plugin:my-plugin:chart', 'Chart',
        { x: 0, y: 0 }, 0, counter, [], {},
        { width: 50, height: 50 },
      );

      expect(view.size.width).toBeGreaterThanOrEqual(200);
      expect(view.size.height).toBeGreaterThanOrEqual(150);
    });

    it('deduplicates display name', () => {
      const view = createPluginView(
        'my-plugin', 'plugin:my-plugin:chart', 'Chart',
        { x: 0, y: 0 }, 0, counter, ['Chart', 'Chart (2)'],
      );

      expect(view.displayName).toBe('Chart (3)');
    });
  });

  // ── queryViews ──────────────────────────────────────────────────────

  describe('queryViews', () => {
    const views: CanvasView[] = [
      {
        id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 },
        title: 'Agent', displayName: 'Agent', zIndex: 0, agentId: 'agent-1', projectId: 'proj-1',
        metadata: { agentId: 'agent-1', projectId: 'proj-1' },
      } as AgentCanvasView,
      {
        id: 'cv_2', type: 'agent', position: { x: 500, y: 0 }, size: { width: 480, height: 480 },
        title: 'Agent', displayName: 'Agent (2)', zIndex: 1, agentId: 'agent-2', projectId: 'proj-1',
        metadata: { agentId: 'agent-2', projectId: 'proj-1' },
      } as AgentCanvasView,
      {
        id: 'cv_3', type: 'plugin', position: { x: 0, y: 500 }, size: { width: 480, height: 480 },
        title: 'Chart', displayName: 'Chart', zIndex: 2,
        pluginWidgetType: 'plugin:my-plugin:chart', pluginId: 'my-plugin',
        metadata: { dataSource: 'api' },
      } as PluginCanvasView,
    ];

    it('returns all views when no filter', () => {
      const handles = queryViews(views);
      expect(handles).toHaveLength(3);
    });

    it('filters by type', () => {
      const handles = queryViews(views, { type: 'agent' });
      expect(handles).toHaveLength(2);
      expect(handles.every((h) => h.type === 'agent')).toBe(true);
    });

    it('filters by plugin widget type', () => {
      const handles = queryViews(views, { type: 'plugin:my-plugin:chart' });
      expect(handles).toHaveLength(1);
      expect(handles[0].id).toBe('cv_3');
    });

    it('filters by id', () => {
      const handles = queryViews(views, { id: 'cv_2' });
      expect(handles).toHaveLength(1);
      expect(handles[0].displayName).toBe('Agent (2)');
    });

    it('filters by metadata', () => {
      const handles = queryViews(views, { metadata: { agentId: 'agent-1' } });
      expect(handles).toHaveLength(1);
      expect(handles[0].id).toBe('cv_1');
    });

    it('filters by metadata across types', () => {
      const handles = queryViews(views, { metadata: { projectId: 'proj-1' } });
      expect(handles).toHaveLength(2);
    });

    it('filters by displayName substring', () => {
      const handles = queryViews(views, { displayName: 'chart' });
      expect(handles).toHaveLength(1);
      expect(handles[0].id).toBe('cv_3');
    });

    it('combines filters (AND logic)', () => {
      const handles = queryViews(views, { type: 'agent', metadata: { agentId: 'agent-2' } });
      expect(handles).toHaveLength(1);
      expect(handles[0].id).toBe('cv_2');
    });

    it('returns empty for no matches', () => {
      expect(queryViews(views, { type: 'nonexistent' })).toHaveLength(0);
      expect(queryViews(views, { metadata: { agentId: 'nonexistent' } })).toHaveLength(0);
    });

    it('returns handles with correct type for plugin views', () => {
      const handles = queryViews(views, { id: 'cv_3' });
      expect(handles[0].type).toBe('plugin:my-plugin:chart');
      expect(handles[0].metadata).toEqual({ dataSource: 'api' });
    });
  });
});
