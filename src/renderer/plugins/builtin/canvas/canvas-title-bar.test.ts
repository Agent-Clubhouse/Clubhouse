import { describe, it, expect } from 'vitest';
import { formatViewType, buildProjectContext } from './CanvasView';
import type { CanvasView } from './canvas-types';
import type { ProjectInfo } from '../../../../shared/plugin-types';

// ── formatViewType ──────────────────────────────────────────────────

describe('Canvas title bar — formatViewType', () => {
  it('capitalises first letter of simple types', () => {
    expect(formatViewType('agent')).toBe('Agent');
    expect(formatViewType('file')).toBe('File');
    expect(formatViewType('browser')).toBe('Browser');
  });

  it('replaces hyphens with spaces', () => {
    expect(formatViewType('git-diff')).toBe('Git diff');
  });

  it('handles plugin widget type names', () => {
    expect(formatViewType('timeline')).toBe('Timeline');
    expect(formatViewType('my-widget')).toBe('My widget');
  });

  it('handles single character types', () => {
    expect(formatViewType('x')).toBe('X');
  });

  it('handles already capitalised input', () => {
    expect(formatViewType('Agent')).toBe('Agent');
  });
});

// ── buildProjectContext ─────────────────────────────────────────────

const projects: ProjectInfo[] = [
  { id: 'p1', name: 'Clubhouse', path: '/home/user/Clubhouse' },
  { id: 'p2', name: 'OtherApp', path: '/home/user/OtherApp' },
];

function makeView(overrides: Partial<CanvasView> & { type: string }): CanvasView {
  return {
    id: 'cv_1',
    position: { x: 0, y: 0 },
    size: { width: 480, height: 480 },
    title: 'Test',
    displayName: 'Test',
    zIndex: 1,
    metadata: {},
    ...overrides,
  } as CanvasView;
}

describe('Canvas title bar — buildProjectContext', () => {
  it('returns project name for agent view with projectId', () => {
    const view = makeView({ type: 'agent', agentId: 'a1', projectId: 'p1' });
    expect(buildProjectContext(view, projects)).toBe('Clubhouse');
  });

  it('returns project name for file view with projectId', () => {
    const view = makeView({ type: 'file', projectId: 'p2', filePath: 'src/index.ts' });
    expect(buildProjectContext(view, projects)).toBe('OtherApp');
  });

  it('returns null when view has no projectId', () => {
    const view = makeView({ type: 'agent', agentId: 'a1' });
    expect(buildProjectContext(view, projects)).toBeNull();
  });

  it('returns null when projectId does not match any project', () => {
    const view = makeView({ type: 'agent', agentId: 'a1', projectId: 'unknown' });
    expect(buildProjectContext(view, projects)).toBeNull();
  });

  it('returns null for browser views (no projectId field)', () => {
    const view = makeView({ type: 'browser', url: 'https://example.com' });
    expect(buildProjectContext(view, projects)).toBeNull();
  });

  it('returns project::worktree for legacy-git-diff view with worktreePath', () => {
    const view = makeView({
      type: 'legacy-git-diff',
      projectId: 'p1',
      worktreePath: '/home/user/Clubhouse/.clubhouse/agents/curious-tapir',
    });
    expect(buildProjectContext(view, projects)).toBe('Clubhouse::curious-tapir');
  });

  it('returns just project name for legacy-git-diff view without worktreePath', () => {
    const view = makeView({ type: 'legacy-git-diff', projectId: 'p1' });
    expect(buildProjectContext(view, projects)).toBe('Clubhouse');
  });

  it('handles worktreePath with trailing slash', () => {
    const view = makeView({
      type: 'legacy-git-diff',
      projectId: 'p1',
      worktreePath: '/home/user/Clubhouse/.clubhouse/agents/curious-tapir/',
    });
    expect(buildProjectContext(view, projects)).toBe('Clubhouse::curious-tapir');
  });
});

// ── Sleep button visibility logic ──────────────────────────────────

describe('Canvas title bar — sleep button visibility', () => {
  /**
   * Mirrors the logic in CanvasView that determines whether the sleep
   * button renders in the title bar:
   *   const isAgentRunning = agentInfo != null && (agentInfo.status === 'running' || agentInfo.status === 'creating');
   */
  function shouldShowSleepButton(
    viewType: string,
    agentStatus: string | null,
  ): boolean {
    if (viewType !== 'agent') return false;
    return agentStatus === 'running' || agentStatus === 'creating';
  }

  it('shows sleep button for a running agent', () => {
    expect(shouldShowSleepButton('agent', 'running')).toBe(true);
  });

  it('shows sleep button for a creating agent', () => {
    expect(shouldShowSleepButton('agent', 'creating')).toBe(true);
  });

  it('hides sleep button for a sleeping agent', () => {
    expect(shouldShowSleepButton('agent', 'sleeping')).toBe(false);
  });

  it('hides sleep button for an error agent', () => {
    expect(shouldShowSleepButton('agent', 'error')).toBe(false);
  });

  it('hides sleep button when agent info is null', () => {
    expect(shouldShowSleepButton('agent', null)).toBe(false);
  });

  it('hides sleep button for non-agent view types', () => {
    expect(shouldShowSleepButton('file', 'running')).toBe(false);
    expect(shouldShowSleepButton('browser', 'running')).toBe(false);
    expect(shouldShowSleepButton('git-diff', 'running')).toBe(false);
    expect(shouldShowSleepButton('plugin', 'running')).toBe(false);
  });
});

// ── Plugin widget type extraction ───────────────────────────────────

function extractPluginWidgetType(pluginWidgetType: string): string {
  return pluginWidgetType.split(':').pop() || '';
}

describe('Canvas title bar — plugin widget type extraction', () => {
  it('extracts last segment from colon-delimited string', () => {
    expect(extractPluginWidgetType('canvas:my-plugin:timeline')).toBe('timeline');
  });

  it('returns full string when no colons present', () => {
    expect(extractPluginWidgetType('timeline')).toBe('timeline');
  });

  it('handles double-colon edge case', () => {
    expect(extractPluginWidgetType('a::b')).toBe('b');
  });

  it('returns empty string for trailing colon', () => {
    expect(extractPluginWidgetType('a:b:')).toBe('');
  });
});
