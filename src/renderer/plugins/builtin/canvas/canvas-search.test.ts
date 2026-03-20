import { describe, it, expect } from 'vitest';
import type { CanvasView, AgentCanvasView, PluginCanvasView } from './canvas-types';

// ── Inline the search logic for unit testing ─────────────────────────

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
  if (view.type === 'agent' && view.agentId) parts.push(view.agentId);
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

// ── Test fixtures ────────────────────────────────────────────────────

const baseView = {
  position: { x: 0, y: 0 },
  size: { width: 480, height: 480 },
  zIndex: 0,
};

const agentView: AgentCanvasView = {
  ...baseView,
  id: 'cv_1',
  type: 'agent',
  title: 'Agent',
  displayName: 'My Agent',
  metadata: {
    agentName: 'curious-tapir',
    projectName: 'Clubhouse',
    orchestrator: 'claude-code',
    model: 'claude-sonnet-4-5-20250514',
  },
  agentId: 'agent_123',
};

const browserPluginView: PluginCanvasView = {
  ...baseView,
  id: 'cv_2',
  type: 'plugin',
  title: 'Browser',
  displayName: 'Docs Browser',
  metadata: { url: 'https://docs.example.com' },
  pluginWidgetType: 'plugin:browser:webview',
  pluginId: 'browser',
};

const terminalPluginView: PluginCanvasView = {
  ...baseView,
  id: 'cv_3',
  type: 'plugin',
  title: 'Terminal',
  displayName: 'My Terminal',
  metadata: {},
  pluginWidgetType: 'plugin:terminal:shell',
  pluginId: 'terminal',
};

const allViews: CanvasView[] = [agentView, browserPluginView, terminalPluginView];

// ── Tests ────────────────────────────────────────────────────────────

describe('canvas search — buildSearchableText', () => {
  it('includes displayName in searchable text', () => {
    const text = buildSearchableText(agentView);
    expect(text).toContain('my agent');
  });

  it('includes type in searchable text', () => {
    const text = buildSearchableText(agentView);
    expect(text).toContain('agent');
  });

  it('includes metadata values in searchable text', () => {
    const text = buildSearchableText(agentView);
    expect(text).toContain('curious-tapir');
  });

  it('includes projectName in searchable text for agent views', () => {
    const text = buildSearchableText(agentView);
    expect(text).toContain('clubhouse');
  });

  it('includes orchestrator in searchable text for agent views', () => {
    const text = buildSearchableText(agentView);
    expect(text).toContain('claude-code');
  });

  it('includes model in searchable text for agent views', () => {
    const text = buildSearchableText(agentView);
    expect(text).toContain('claude-sonnet-4-5-20250514');
  });

  it('includes pluginWidgetType for plugin views', () => {
    const text = buildSearchableText(terminalPluginView);
    expect(text).toContain('plugin:terminal:shell');
  });

  it('includes metadata url for browser plugin views', () => {
    const text = buildSearchableText(browserPluginView);
    expect(text).toContain('docs.example.com');
  });
});

describe('canvas search — filterViews', () => {
  it('returns all views when query is empty', () => {
    expect(filterViews(allViews, '')).toEqual(allViews);
    expect(filterViews(allViews, '   ')).toEqual(allViews);
  });

  it('filters by type keyword', () => {
    const result = filterViews(allViews, 'agent');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_1');
  });

  it('filters by display name', () => {
    const result = filterViews(allViews, 'docs browser');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_2');
  });

  it('filters by metadata value', () => {
    const result = filterViews(allViews, 'curious-tapir');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_1');
  });

  it('is case-insensitive', () => {
    const result = filterViews(allViews, 'BROWSER');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_2');
  });

  it('filters by plugin widget type', () => {
    const result = filterViews(allViews, 'terminal');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_3');
  });

  it('returns empty array when nothing matches', () => {
    const result = filterViews(allViews, 'nonexistent');
    expect(result).toHaveLength(0);
  });

  it('matches partial strings', () => {
    const result = filterViews(allViews, 'brow');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_2');
  });

  it('matches against URL in metadata', () => {
    const result = filterViews(allViews, 'example.com');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_2');
  });

  it('filters agent by project name', () => {
    const result = filterViews(allViews, 'clubhouse');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_1');
  });

  it('filters agent by orchestrator', () => {
    const result = filterViews(allViews, 'claude-code');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_1');
  });

  it('filters agent by model name', () => {
    const result = filterViews(allViews, 'sonnet');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_1');
  });

  it('combines project name + agent name for precise search', () => {
    const result = filterViews(allViews, 'clubhouse curious');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cv_1');
  });
});
