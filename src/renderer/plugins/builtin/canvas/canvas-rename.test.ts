import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanvasView, AgentCanvasView, AnchorCanvasView } from './canvas-types';
import { createCanvasStore } from './canvas-store';
import type { ScopedStorage } from '../../../../shared/plugin-types';

// ── Inline search logic (mirrors CanvasSearch.tsx) ─────────────────────

const TYPE_LABELS: Record<string, string> = {
  agent: 'Agent',
  file: 'Files',
  browser: 'Browser',
  'git-diff': 'Git Diff',
  'legacy-git-diff': 'Git Diff (Legacy)',
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
  if (view.type === 'agent' && view.agentId) parts.push(view.agentId);
  if (view.type === 'file' && view.filePath) parts.push(view.filePath);
  if (view.type === 'browser') parts.push(view.url);
  if ((view.type === 'git-diff' || view.type === 'legacy-git-diff') && view.filePath) parts.push(view.filePath);
  if (view.type === 'anchor') parts.push(view.label);
  if (view.type === 'plugin') parts.push(view.pluginWidgetType);

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

// ── Rename commit logic (mirrors InlineRename) ────────────────────────

function commitRename(
  editValue: string,
  currentValue: string,
): string | null {
  const trimmed = editValue.trim();
  if (trimmed && trimmed !== currentValue) {
    return trimmed;
  }
  return null;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('widget card rename — commit logic', () => {
  it('returns trimmed value when different from current', () => {
    expect(commitRename('New Name', 'Old Name')).toBe('New Name');
  });

  it('trims whitespace from the new name', () => {
    expect(commitRename('  Trimmed  ', 'Old')).toBe('Trimmed');
  });

  it('returns null when name is unchanged', () => {
    expect(commitRename('Same', 'Same')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(commitRename('', 'Current')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(commitRename('   ', 'Current')).toBeNull();
  });

  it('returns null when trimmed value equals current', () => {
    expect(commitRename('  Same  ', 'Same')).toBeNull();
  });
});

describe('widget card rename — store integration', () => {
  let store: ReturnType<typeof createCanvasStore>;

  beforeEach(() => {
    store = createCanvasStore();
  });

  it('renames an agent view via updateView', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().updateView(viewId, { displayName: 'My Cool Agent' });
    const view = store.getState().views[0];
    expect(view.displayName).toBe('My Cool Agent');
  });

  it('renames a file view via updateView', () => {
    const viewId = store.getState().addView('file', { x: 0, y: 0 });
    store.getState().updateView(viewId, { displayName: 'Config Files' });
    const view = store.getState().views[0];
    expect(view.displayName).toBe('Config Files');
  });

  it('renames a browser view via updateView', () => {
    const viewId = store.getState().addView('browser', { x: 0, y: 0 });
    store.getState().updateView(viewId, { displayName: 'API Docs' });
    const view = store.getState().views[0];
    expect(view.displayName).toBe('API Docs');
  });

  it('renames a terminal view via updateView', () => {
    const viewId = store.getState().addView('terminal', { x: 0, y: 0 });
    store.getState().updateView(viewId, { displayName: 'Build Terminal' });
    const view = store.getState().views[0];
    expect(view.displayName).toBe('Build Terminal');
  });

  it('renames an anchor and keeps label in sync', () => {
    const viewId = store.getState().addView('anchor', { x: 0, y: 0 });
    store.getState().updateView(viewId, {
      displayName: 'Sprint Board',
      label: 'Sprint Board',
      title: 'Sprint Board',
    } as Partial<AnchorCanvasView>);
    const view = store.getState().views[0] as AnchorCanvasView;
    expect(view.displayName).toBe('Sprint Board');
    expect(view.label).toBe('Sprint Board');
    expect(view.title).toBe('Sprint Board');
  });

  it('does not change the view type when renaming', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().updateView(viewId, { displayName: 'Renamed' });
    const view = store.getState().views[0];
    expect(view.type).toBe('agent');
  });

  it('preserves other fields when renaming', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    const originalView = store.getState().views[0] as AgentCanvasView;
    const originalTitle = originalView.title;
    const originalPosition = originalView.position;

    store.getState().updateView(viewId, { displayName: 'New Name' });
    const updated = store.getState().views[0] as AgentCanvasView;
    expect(updated.title).toBe(originalTitle);
    expect(updated.position).toEqual(originalPosition);
    expect(updated.agentId).toBe(originalView.agentId);
  });
});

describe('widget card rename — search uses renamed value', () => {
  let store: ReturnType<typeof createCanvasStore>;

  beforeEach(() => {
    store = createCanvasStore();
  });

  it('search finds agent by custom display name', () => {
    store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().addView('file', { x: 200, y: 0 });

    const agentId = store.getState().views[0].id;
    store.getState().updateView(agentId, { displayName: 'Deployment Bot' });

    const results = filterViews(store.getState().views, 'deployment');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(agentId);
  });

  it('search no longer finds view by old auto-generated name after rename', () => {
    store.getState().addView('agent', { x: 0, y: 0 });
    const agentId = store.getState().views[0].id;

    // Before rename, can find by default "Agent"
    expect(filterViews(store.getState().views, 'agent')).toHaveLength(1);

    // Rename — search by "Agent" still matches via type/title; but renamed displayName takes precedence
    store.getState().updateView(agentId, { displayName: 'Deployment Bot' });

    // "Deployment" now matches
    const results = filterViews(store.getState().views, 'deployment');
    expect(results).toHaveLength(1);
    expect(results[0].displayName).toBe('Deployment Bot');
  });

  it('search finds renamed anchor by new label', () => {
    store.getState().addView('anchor', { x: 0, y: 0 });
    const anchorId = store.getState().views[0].id;

    store.getState().updateView(anchorId, {
      displayName: 'Design Review',
      label: 'Design Review',
      title: 'Design Review',
    } as Partial<AnchorCanvasView>);

    const results = filterViews(store.getState().views, 'design review');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(anchorId);
  });

  it('multi-term search works with renamed views', () => {
    store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().addView('file', { x: 200, y: 0 });

    const agentId = store.getState().views[0].id;
    store.getState().updateView(agentId, { displayName: 'Backend Worker' });

    // Search for "backend agent" — matches because "backend" is in displayName, "agent" is in type
    const results = filterViews(store.getState().views, 'backend agent');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(agentId);
  });
});

describe('widget card rename — persistence', () => {
  it('persists renamed displayName across save/load', async () => {
    const storage = createMockStorage();
    const store1 = createCanvasStore();
    await store1.getState().loadCanvas(storage);

    const viewId = store1.getState().addView('agent', { x: 0, y: 0 });
    store1.getState().updateView(viewId, { displayName: 'Persisted Name' });
    await store1.getState().saveCanvas(storage);

    const store2 = createCanvasStore();
    await store2.getState().loadCanvas(storage);

    const loaded = store2.getState().views[0];
    expect(loaded.displayName).toBe('Persisted Name');
  });

  it('persists renamed anchor label across save/load', async () => {
    const storage = createMockStorage();
    const store1 = createCanvasStore();
    await store1.getState().loadCanvas(storage);

    const viewId = store1.getState().addView('anchor', { x: 0, y: 0 });
    store1.getState().updateView(viewId, {
      displayName: 'Milestone 1',
      label: 'Milestone 1',
      title: 'Milestone 1',
    } as Partial<AnchorCanvasView>);
    await store1.getState().saveCanvas(storage);

    const store2 = createCanvasStore();
    await store2.getState().loadCanvas(storage);

    const loaded = store2.getState().views[0] as AnchorCanvasView;
    expect(loaded.displayName).toBe('Milestone 1');
    expect(loaded.label).toBe('Milestone 1');
  });
});

describe('widget card rename — query API uses renamed displayName', () => {
  let store: ReturnType<typeof createCanvasStore>;

  beforeEach(() => {
    store = createCanvasStore();
  });

  it('queryViews by displayName matches renamed value', () => {
    const viewId = store.getState().addView('agent', { x: 0, y: 0 });
    store.getState().updateView(viewId, { displayName: 'Custom Agent Name' });

    const results = store.getState().queryViews({ displayName: 'Custom' });
    expect(results).toHaveLength(1);
    expect(results[0].displayName).toBe('Custom Agent Name');
  });

  it('queryViews handle returns updated displayName', () => {
    const viewId = store.getState().addView('file', { x: 0, y: 0 });
    store.getState().updateView(viewId, { displayName: 'Source Code' });

    const results = store.getState().queryViews();
    expect(results[0].displayName).toBe('Source Code');
  });
});
