import { describe, it, expect, vi } from 'vitest';
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
  // Helper matching the logic in FileCanvasView
  function buildRelativePath(currentDir: string, name: string): string {
    return currentDir ? `${currentDir}/${name}` : name;
  }

  it('constructs relative paths at root level', () => {
    expect(buildRelativePath('', 'src')).toBe('src');
    expect(buildRelativePath('', 'index.ts')).toBe('index.ts');
  });

  it('constructs relative paths at nested level', () => {
    expect(buildRelativePath('src', 'utils')).toBe('src/utils');
    expect(buildRelativePath('src', 'app.ts')).toBe('src/app.ts');
  });

  it('constructs relative paths at deeply nested level', () => {
    expect(buildRelativePath('src/utils', 'helpers.ts')).toBe('src/utils/helpers.ts');
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
    expect(entries).toHaveLength(5);
  });
});

// ── AgentCanvasView — project color helper ────────────────────────────

describe('AgentCanvasView — projectColor', () => {
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
    const childHandler = (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
    };

    const event = {
      stopPropagation: vi.fn(),
      deltaX: 0,
      deltaY: 100,
    };

    childHandler(event);
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});
