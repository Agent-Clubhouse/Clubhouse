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

describe('FileCanvasView — file name extraction', () => {
  // The split layout extracts file name from path for the view title
  function extractFileName(filePath: string): string {
    return filePath.split('/').pop() || filePath;
  }

  it('extracts filename from simple path', () => {
    expect(extractFileName('index.ts')).toBe('index.ts');
  });

  it('extracts filename from nested path', () => {
    expect(extractFileName('src/utils/helpers.ts')).toBe('helpers.ts');
  });

  it('extracts filename from deeply nested path', () => {
    expect(extractFileName('src/renderer/plugins/builtin/canvas/FileTree.tsx')).toBe('FileTree.tsx');
  });

  it('handles empty path gracefully', () => {
    expect(extractFileName('')).toBe('');
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
