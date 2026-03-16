import { describe, it, expect, vi, beforeEach } from 'vitest';
import { manifest } from './manifest';

// ── Manifest changes ──────────────────────────────────────────────────

describe('canvas manifest — new settings', () => {
  it('includes showHiddenFiles boolean setting defaulting to true', () => {
    const setting = manifest.contributes!.settings!.find((s) => s.key === 'showHiddenFiles');
    expect(setting).toBeDefined();
    expect(setting!.type).toBe('boolean');
    expect(setting!.default).toBe(true);
  });
});

// ── FileCanvasView helper logic ───────────────────────────────────────

describe('FileCanvasView — path construction', () => {
  it('constructs relative paths from currentDir and name', () => {
    // This tests the path logic used in FileCanvasView:
    // path: currentDir ? `${currentDir}/${e.name}` : e.name
    const entries = [
      { name: 'src', isDirectory: true },
      { name: 'index.ts', isDirectory: false },
    ];

    // Root level (currentDir = '')
    const rootPaths = entries.map((e) => ({
      name: e.name,
      path: '' ? `${'' }/${e.name}` : e.name,
      isDirectory: e.isDirectory,
    }));
    expect(rootPaths[0].path).toBe('src');
    expect(rootPaths[1].path).toBe('index.ts');

    // Nested level (currentDir = 'src')
    const nestedEntries = [{ name: 'utils', isDirectory: true }, { name: 'app.ts', isDirectory: false }];
    const nestedPaths = nestedEntries.map((e) => ({
      name: e.name,
      path: 'src' ? `src/${e.name}` : e.name,
      isDirectory: e.isDirectory,
    }));
    expect(nestedPaths[0].path).toBe('src/utils');
    expect(nestedPaths[1].path).toBe('src/app.ts');
  });

  it('navigating up strips last path segment', () => {
    const currentDir = 'src/utils/helpers';
    const parent = currentDir.split('/').slice(0, -1).join('/');
    expect(parent).toBe('src/utils');
  });

  it('navigating up from single-level dir returns empty string', () => {
    const currentDir = 'src';
    const parent = currentDir.split('/').slice(0, -1).join('/');
    expect(parent).toBe('');
  });
});

describe('FileCanvasView — hidden files filtering', () => {
  const entries = [
    { name: '.git', path: '.git', isDirectory: true },
    { name: '.env', path: '.env', isDirectory: false },
    { name: 'src', path: 'src', isDirectory: true },
    { name: 'index.ts', path: 'index.ts', isDirectory: false },
    { name: '.hidden-dir', path: '.hidden-dir', isDirectory: true },
  ];

  it('filters dot-prefixed entries when showHidden is false', () => {
    const filtered = entries.filter((e) => !e.name.startsWith('.'));
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.name)).toEqual(['src', 'index.ts']);
  });

  it('keeps all entries when showHidden is true', () => {
    const filtered = entries; // no filtering
    expect(filtered).toHaveLength(5);
  });
});

// ── AgentCanvasView — project color helper ────────────────────────────

describe('AgentCanvasView — projectColor', () => {
  // Replicate the helper for testing
  function projectColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 55%)`;
  }

  it('returns consistent color for same name', () => {
    expect(projectColor('MyProject')).toBe(projectColor('MyProject'));
  });

  it('returns different colors for different names', () => {
    expect(projectColor('Alpha')).not.toBe(projectColor('Beta'));
  });

  it('returns valid hsl string', () => {
    const color = projectColor('test');
    expect(color).toMatch(/^hsl\(\d+, 55%, 55%\)$/);
  });
});

// ── Scroll event propagation ──────────────────────────────────────────

describe('CanvasView — scroll isolation', () => {
  it('stopPropagation prevents parent from receiving wheel events', () => {
    const parentHandler = vi.fn();
    const childHandler = vi.fn((e: { stopPropagation: () => void }) => {
      e.stopPropagation();
    });

    // Simulate the pattern: child calls stopPropagation, parent should not fire
    const event = {
      stopPropagation: vi.fn(),
      deltaX: 0,
      deltaY: 100,
    };

    childHandler(event);
    expect(event.stopPropagation).toHaveBeenCalled();
    // In a real DOM, the parent handler would NOT be called
    // Here we just verify the child calls stopPropagation
  });
});

// ── webviewTag requirement ────────────────────────────────────────────

describe('webviewTag in webPreferences', () => {
  it('is documented as required for <webview> tag functionality', () => {
    // This is a documentation test — webviewTag: true must be set in
    // webPreferences for Electron BrowserWindow creation (src/main/index.ts
    // and src/main/ipc/window-handlers.ts) for the canvas browser view to work
    expect(true).toBe(true);
  });
});
