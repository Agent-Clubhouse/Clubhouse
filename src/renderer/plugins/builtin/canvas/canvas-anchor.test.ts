import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createViewCounter,
  createView,
  updateViewSize,
} from './canvas-operations';
import type { CanvasView, AnchorCanvasView } from './canvas-types';
import { DEFAULT_ANCHOR_WIDTH, DEFAULT_ANCHOR_HEIGHT, ANCHOR_HEIGHT, GRID_SIZE } from './canvas-types';
import { createCanvasStore } from './canvas-store';
import type { ScopedStorage } from '../../../../shared/plugin-types';

// ── Inline search logic (mirroring canvas-search.test.ts pattern) ─────

const TYPE_LABELS: Record<string, string> = {
  agent: 'Agent',
  anchor: 'Anchor',
  plugin: 'Plugin',
};

function buildSearchableText(view: CanvasView): string {
  const parts: string[] = [
    view.displayName,
    view.title,
    view.type,
    TYPE_LABELS[view.type] ?? '',
  ];
  for (const [key, val] of Object.entries(view.metadata)) {
    if (val != null) {
      parts.push(String(key), String(val));
    }
  }
  if (view.type === 'anchor') parts.push(view.label);
  return parts.join(' ').toLowerCase();
}

function filterViews(views: CanvasView[], query: string): CanvasView[] {
  if (!query.trim()) return views;
  const terms = query.toLowerCase().trim().split(/\s+/);
  return views.filter((view) => {
    const text = buildSearchableText(view);
    return terms.every((term) => text.includes(term));
  });
}

function createMockStorage(data: Record<string, unknown> = {}): ScopedStorage {
  const store = new Map<string, unknown>(Object.entries(data));
  return {
    read: vi.fn(async (key: string) => store.get(key) ?? undefined),
    write: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => [...store.keys()]),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('anchor canvas widget', () => {
  describe('createView — anchor type', () => {
    it('creates an anchor view with correct defaults', () => {
      const counter = createViewCounter(0);
      const view = createView('anchor', { x: 100, y: 200 }, 5, counter);
      expect(view.type).toBe('anchor');
      expect(view.title).toBe('Anchor');
      expect(view.displayName).toBe('Anchor');
      expect((view as AnchorCanvasView).label).toBe('Anchor');
      expect(view.size.width).toBe(DEFAULT_ANCHOR_WIDTH);
      expect(view.size.height).toBe(DEFAULT_ANCHOR_HEIGHT);
      expect(view.zIndex).toBe(5);
      expect(view.metadata).toEqual({});
    });

    it('snaps anchor position to grid', () => {
      const counter = createViewCounter(0);
      const view = createView('anchor', { x: 105, y: 213 }, 0, counter);
      expect(view.position.x % GRID_SIZE).toBe(0);
      expect(view.position.y % GRID_SIZE).toBe(0);
    });

    it('deduplicates anchor display names', () => {
      const counter = createViewCounter(0);
      const v1 = createView('anchor', { x: 0, y: 0 }, 0, counter, ['Anchor']);
      expect(v1.displayName).toBe('Anchor (2)');
      expect((v1 as AnchorCanvasView).label).toBe('Anchor (2)');
    });

    it('generates sequential IDs for anchor views', () => {
      const counter = createViewCounter(0);
      const v1 = createView('anchor', { x: 0, y: 0 }, 0, counter);
      const v2 = createView('anchor', { x: 100, y: 0 }, 1, counter);
      expect(v1.id).toBe('cv_1');
      expect(v2.id).toBe('cv_2');
    });
  });

  describe('search — anchor views', () => {
    const anchorView: AnchorCanvasView = {
      id: 'cv_10',
      type: 'anchor',
      position: { x: 0, y: 0 },
      size: { width: DEFAULT_ANCHOR_WIDTH, height: ANCHOR_HEIGHT },
      title: 'Anchor',
      displayName: 'Section Header',
      metadata: {},
      zIndex: 0,
      label: 'Section Header',
    };

    const otherView: CanvasView = {
      id: 'cv_11',
      type: 'agent',
      position: { x: 100, y: 0 },
      size: { width: 480, height: 480 },
      title: 'Agent',
      displayName: 'My Agent',
      metadata: {},
      zIndex: 1,
      agentId: null,
    };

    const allViews: CanvasView[] = [anchorView, otherView];

    it('includes anchor label in searchable text', () => {
      const text = buildSearchableText(anchorView);
      expect(text).toContain('section header');
    });

    it('includes anchor type label in searchable text', () => {
      const text = buildSearchableText(anchorView);
      expect(text).toContain('anchor');
    });

    it('filters by anchor display name', () => {
      const result = filterViews(allViews, 'section');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('cv_10');
    });

    it('filters by anchor type keyword', () => {
      const result = filterViews(allViews, 'anchor');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('cv_10');
    });

    it('empty query returns all views including anchors', () => {
      const result = filterViews(allViews, '');
      expect(result).toHaveLength(2);
    });
  });

  describe('store — anchor operations', () => {
    let store: ReturnType<typeof createCanvasStore>;

    beforeEach(() => {
      store = createCanvasStore();
    });

    it('adds an anchor view to the active canvas', () => {
      const viewId = store.getState().addView('anchor', { x: 100, y: 100 });
      expect(viewId).toBeTruthy();
      const views = store.getState().views;
      expect(views).toHaveLength(1);
      expect(views[0].type).toBe('anchor');
      expect((views[0] as AnchorCanvasView).label).toBe('Anchor');
    });

    it('removes an anchor view', () => {
      const viewId = store.getState().addView('anchor', { x: 0, y: 0 });
      expect(store.getState().views).toHaveLength(1);
      store.getState().removeView(viewId);
      expect(store.getState().views).toHaveLength(0);
    });

    it('updates anchor view fields', () => {
      const viewId = store.getState().addView('anchor', { x: 0, y: 0 });
      store.getState().updateView(viewId, { label: 'New Label', displayName: 'New Label', title: 'New Label' } as Partial<AnchorCanvasView>);
      const view = store.getState().views[0] as AnchorCanvasView;
      expect(view.label).toBe('New Label');
      expect(view.displayName).toBe('New Label');
    });

    it('persists and loads anchor views round-trip', async () => {
      const storage = createMockStorage();
      await store.getState().loadCanvas(storage);

      store.getState().addView('anchor', { x: 50, y: 50 });
      store.getState().updateView(store.getState().views[0].id, {
        label: 'My Anchor',
        displayName: 'My Anchor',
        title: 'My Anchor',
      } as Partial<AnchorCanvasView>);

      await store.getState().saveCanvas(storage);

      const store2 = createCanvasStore();
      await store2.getState().loadCanvas(storage);

      expect(store2.getState().views).toHaveLength(1);
      const loaded = store2.getState().views[0] as AnchorCanvasView;
      expect(loaded.type).toBe('anchor');
      expect(loaded.label).toBe('My Anchor');
      expect(loaded.displayName).toBe('My Anchor');
    });

    it('queries anchor views by type', () => {
      store.getState().addView('anchor', { x: 0, y: 0 });
      store.getState().addView('agent', { x: 200, y: 0 });
      store.getState().addView('anchor', { x: 400, y: 0 });

      const result = store.getState().queryViews({ type: 'anchor' });
      expect(result).toHaveLength(2);
      expect(result.every((h) => h.type === 'anchor')).toBe(true);
    });
  });

  describe('compact anchor — fixed height', () => {
    it('creates anchor with height equal to ANCHOR_HEIGHT', () => {
      const counter = createViewCounter(0);
      const view = createView('anchor', { x: 0, y: 0 }, 0, counter);
      expect(view.size.height).toBe(ANCHOR_HEIGHT);
      expect(view.size.height).toBe(50);
    });

    it('updateViewSize forces anchor height to ANCHOR_HEIGHT', () => {
      const counter = createViewCounter(0);
      const view = createView('anchor', { x: 0, y: 0 }, 0, counter) as AnchorCanvasView;
      const updated = updateViewSize([view], view.id, { width: 300, height: 500 });
      expect(updated[0].size.height).toBe(ANCHOR_HEIGHT);
      expect(updated[0].size.width).toBe(300);
    });

    it('updateViewSize still enforces MIN_VIEW_HEIGHT for non-anchor views', () => {
      const counter = createViewCounter(0);
      const agent = createView('agent', { x: 0, y: 0 }, 0, counter);
      const updated = updateViewSize([agent], agent.id, { width: 300, height: 50 });
      expect(updated[0].size.height).toBe(150); // MIN_VIEW_HEIGHT
    });

    it('defaults autoCollapse to undefined', () => {
      const counter = createViewCounter(0);
      const view = createView('anchor', { x: 0, y: 0 }, 0, counter) as AnchorCanvasView;
      expect(view.autoCollapse).toBeUndefined();
    });

    it('persists autoCollapse via updateView', () => {
      const store = createCanvasStore();
      const viewId = store.getState().addView('anchor', { x: 0, y: 0 });
      store.getState().updateView(viewId, { autoCollapse: true } as Partial<AnchorCanvasView>);
      const view = store.getState().views[0] as AnchorCanvasView;
      expect(view.autoCollapse).toBe(true);
    });

    it('persists autoCollapse through save/load', async () => {
      const storage = createMockStorage();
      const store1 = createCanvasStore();
      await store1.getState().loadCanvas(storage);

      const viewId = store1.getState().addView('anchor', { x: 0, y: 0 });
      store1.getState().updateView(viewId, { autoCollapse: true } as Partial<AnchorCanvasView>);
      await store1.getState().saveCanvas(storage);

      const store2 = createCanvasStore();
      await store2.getState().loadCanvas(storage);

      const loaded = store2.getState().views[0] as AnchorCanvasView;
      expect(loaded.autoCollapse).toBe(true);
    });
  });

  describe('anchor cycler', () => {
    it('counts anchor views correctly', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'anchor', position: { x: 0, y: 0 }, size: { width: 240, height: ANCHOR_HEIGHT }, title: 'A', displayName: 'A', metadata: {}, zIndex: 0, label: 'A' } as AnchorCanvasView,
        { id: 'cv_2', type: 'agent', position: { x: 200, y: 0 }, size: { width: 480, height: 480 }, title: 'Agent', displayName: 'Agent', metadata: {}, zIndex: 1, agentId: null },
        { id: 'cv_3', type: 'anchor', position: { x: 400, y: 0 }, size: { width: 240, height: ANCHOR_HEIGHT }, title: 'B', displayName: 'B', metadata: {}, zIndex: 2, label: 'B' } as AnchorCanvasView,
      ];

      const anchorIds = views.filter((v) => v.type === 'anchor').map((v) => v.id);
      expect(anchorIds).toEqual(['cv_1', 'cv_3']);
      expect(anchorIds).toHaveLength(2);
    });

    it('cycles through anchors wrapping around', () => {
      const anchors = ['cv_1', 'cv_3', 'cv_5'];
      let index = 0;

      // Go next 3 times — should wrap around
      index = (index + 1) % anchors.length; // 1
      expect(anchors[index]).toBe('cv_3');
      index = (index + 1) % anchors.length; // 2
      expect(anchors[index]).toBe('cv_5');
      index = (index + 1) % anchors.length; // 0 (wrap)
      expect(anchors[index]).toBe('cv_1');

      // Go prev from 0 — should wrap to end
      index = (index - 1 + anchors.length) % anchors.length; // 2
      expect(anchors[index]).toBe('cv_5');
    });
  });
});
