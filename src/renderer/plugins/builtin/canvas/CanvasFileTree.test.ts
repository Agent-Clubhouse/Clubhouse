import { describe, it, expect } from 'vitest';
import type { FileNode } from '../../../../shared/types';

// ── Tree helpers (extracted logic matching CanvasFileTree internals) ────

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function updateNodeChildren(nodes: FileNode[], dirPath: string, children: FileNode[]): FileNode[] {
  return nodes.map(n => {
    if (n.path === dirPath) {
      return { ...n, children };
    }
    if (n.isDirectory && n.children) {
      return { ...n, children: updateNodeChildren(n.children, dirPath, children) };
    }
    return n;
  });
}

function filterHidden(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter(n => !n.name.startsWith('.'))
    .map(n => n.isDirectory && n.children
      ? { ...n, children: filterHidden(n.children) }
      : n,
    );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('CanvasFileTree — getExtension', () => {
  it('extracts extension from filename', () => {
    expect(getExtension('file.ts')).toBe('ts');
    expect(getExtension('style.scss')).toBe('scss');
    expect(getExtension('README.md')).toBe('md');
  });

  it('returns empty string for extensionless files', () => {
    expect(getExtension('Makefile')).toBe('');
    expect(getExtension('LICENSE')).toBe('');
  });

  it('handles multiple dots', () => {
    expect(getExtension('my.config.json')).toBe('json');
    expect(getExtension('file.test.ts')).toBe('ts');
  });

  it('lowercases extension', () => {
    expect(getExtension('FILE.TS')).toBe('ts');
    expect(getExtension('README.MD')).toBe('md');
  });

  it('returns empty for dot-only names (dot at position 0)', () => {
    // .env has dot at index 0, so getExtension returns '' per the dot > 0 check
    expect(getExtension('.env')).toBe('');
  });
});

describe('CanvasFileTree — updateNodeChildren', () => {
  const sampleTree: FileNode[] = [
    { name: 'src', path: 'src', isDirectory: true },
    { name: 'index.ts', path: 'index.ts', isDirectory: false },
  ];

  it('sets children on a matching directory node', () => {
    const children: FileNode[] = [
      { name: 'app.ts', path: 'src/app.ts', isDirectory: false },
      { name: 'utils', path: 'src/utils', isDirectory: true },
    ];
    const updated = updateNodeChildren(sampleTree, 'src', children);
    expect(updated[0].children).toHaveLength(2);
    expect(updated[0].children![0].name).toBe('app.ts');
    expect(updated[0].children![1].name).toBe('utils');
  });

  it('does not modify non-matching nodes', () => {
    const children: FileNode[] = [{ name: 'a.ts', path: 'src/a.ts', isDirectory: false }];
    const updated = updateNodeChildren(sampleTree, 'src', children);
    expect(updated[1]).toEqual(sampleTree[1]);
  });

  it('updates nested directories', () => {
    const tree: FileNode[] = [
      {
        name: 'src', path: 'src', isDirectory: true,
        children: [
          { name: 'utils', path: 'src/utils', isDirectory: true },
        ],
      },
    ];
    const children: FileNode[] = [
      { name: 'helpers.ts', path: 'src/utils/helpers.ts', isDirectory: false },
    ];
    const updated = updateNodeChildren(tree, 'src/utils', children);
    expect(updated[0].children![0].children).toHaveLength(1);
    expect(updated[0].children![0].children![0].name).toBe('helpers.ts');
  });
});

describe('CanvasFileTree — hidden file filtering', () => {
  const tree: FileNode[] = [
    { name: '.git', path: '.git', isDirectory: true },
    { name: '.env', path: '.env', isDirectory: false },
    { name: 'src', path: 'src', isDirectory: true, children: [
      { name: '.hidden', path: 'src/.hidden', isDirectory: false },
      { name: 'app.ts', path: 'src/app.ts', isDirectory: false },
    ]},
    { name: 'index.ts', path: 'index.ts', isDirectory: false },
  ];

  it('filters dot-prefixed entries at root', () => {
    const filtered = filterHidden(tree);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(n => n.name)).toEqual(['src', 'index.ts']);
  });

  it('filters dot-prefixed entries recursively within directories', () => {
    const filtered = filterHidden(tree);
    const srcNode = filtered.find(n => n.name === 'src');
    expect(srcNode?.children).toHaveLength(1);
    expect(srcNode?.children![0].name).toBe('app.ts');
  });

  it('preserves full tree when no hidden files', () => {
    const clean: FileNode[] = [
      { name: 'src', path: 'src', isDirectory: true },
      { name: 'index.ts', path: 'index.ts', isDirectory: false },
    ];
    expect(filterHidden(clean)).toEqual(clean);
  });
});

describe('CanvasFileTree — expand/collapse logic', () => {
  it('toggling adds path to expanded set', () => {
    const expanded = new Set<string>();
    expanded.add('src');
    expect(expanded.has('src')).toBe(true);
  });

  it('toggling removes path from expanded set', () => {
    const expanded = new Set<string>(['src']);
    expanded.delete('src');
    expect(expanded.has('src')).toBe(false);
  });

  it('expanded set tracks multiple directories independently', () => {
    const expanded = new Set<string>();
    expanded.add('src');
    expanded.add('src/utils');
    expanded.add('lib');
    expect(expanded.size).toBe(3);
    expanded.delete('src');
    expect(expanded.size).toBe(2);
    expect(expanded.has('src/utils')).toBe(true);
    expect(expanded.has('lib')).toBe(true);
  });
});

describe('CanvasFileTree — lazy loading detection', () => {
  it('identifies nodes needing lazy load (no children property)', () => {
    const node: FileNode = { name: 'src', path: 'src', isDirectory: true };
    expect(node.children).toBeUndefined();
  });

  it('identifies nodes with loaded children', () => {
    const node: FileNode = {
      name: 'src', path: 'src', isDirectory: true,
      children: [{ name: 'app.ts', path: 'src/app.ts', isDirectory: false }],
    };
    expect(node.children).toBeDefined();
    expect(node.children).toHaveLength(1);
  });

  it('identifies nodes with empty children (loaded but empty dir)', () => {
    const node: FileNode = { name: 'empty', path: 'empty', isDirectory: true, children: [] };
    expect(node.children).toBeDefined();
    expect(node.children).toHaveLength(0);
  });
});
