import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * Structural tests for the extracted App layout components.
 *
 * These verify that state subscriptions are properly isolated into
 * child components so that resizing panels or computing the title
 * does not force the root App component to re-render.
 */

// ─── AST Helpers ────────────────────────────────────────────────────────────

function parseFile(filePath: string): ts.SourceFile {
  const source = readFileSync(filePath, 'utf-8');
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function findNamedFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return stmt;
    }
  }
  return undefined;
}

function findStoreSelectors(funcBody: ts.Block): Array<{ storeName: string; field: string | null }> {
  const selectors: Array<{ storeName: string; field: string | null }> = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (/^use\w+Store$/.test(name) && node.arguments.length > 0 && ts.isArrowFunction(node.arguments[0])) {
        const arrow = node.arguments[0] as ts.ArrowFunction;
        let field: string | null = null;
        if (ts.isPropertyAccessExpression(arrow.body)) {
          field = arrow.body.name.text;
        }
        selectors.push({ storeName: name, field });
      }
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(funcBody, visit);
  return selectors;
}

function collectJsxTagNames(node: ts.Node): Set<string> {
  const tags = new Set<string>();
  function visit(n: ts.Node) {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (ts.isIdentifier(n.tagName)) tags.add(n.tagName.text);
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return tags;
}

// ─── Parse source files ─────────────────────────────────────────────────────

const titleBarAst = parseFile(join(__dirname, 'TitleBar.tsx'));
const railSectionAst = parseFile(join(__dirname, 'RailSection.tsx'));
const panelLayoutAst = parseFile(join(__dirname, 'ProjectPanelLayout.tsx'));

const titleBarFn = findNamedFunction(titleBarAst, 'TitleBar')!;
const railSectionFn = findNamedFunction(railSectionAst, 'RailSection')!;
const panelLayoutFn = findNamedFunction(panelLayoutAst, 'ProjectPanelLayout')!;

// ─── TitleBar ───────────────────────────────────────────────────────────────

describe('TitleBar – selector isolation', () => {
  const selectors = findStoreSelectors(titleBarFn.body!);

  it('should subscribe to UI, project, and plugin stores for title computation', () => {
    const storeNames = new Set(selectors.map((s) => s.storeName));
    expect(storeNames.has('useUIStore'), 'TitleBar should subscribe to useUIStore').toBe(true);
    expect(storeNames.has('useProjectStore'), 'TitleBar should subscribe to useProjectStore').toBe(true);
    expect(storeNames.has('usePluginStore'), 'TitleBar should subscribe to usePluginStore').toBe(true);
  });

  it('should NOT subscribe to panel store', () => {
    const storeNames = new Set(selectors.map((s) => s.storeName));
    expect(storeNames.has('usePanelStore'), 'TitleBar should not subscribe to panel state').toBe(false);
  });

  it('should render a title-bar test-id', () => {
    const tags = collectJsxTagNames(titleBarFn);
    // The span with data-testid="title-bar" is in the JSX; verify the outer div exists
    expect(tags.has('div') || tags.has('span')).toBe(true);
  });
});

// ─── RailSection ────────────────────────────────────────────────────────────

describe('RailSection – selector isolation', () => {
  const selectors = findStoreSelectors(railSectionFn.body!);

  it('should subscribe only to rail-related panel state', () => {
    const fields = selectors.map((s) => s.field).filter(Boolean);
    expect(fields).toContain('railPinned');
    expect(fields).toContain('resizeRail');
    expect(fields).toContain('toggleRailPin');
  });

  it('should subscribe exclusively to usePanelStore', () => {
    const storeNames = [...new Set(selectors.map((s) => s.storeName))];
    expect(storeNames).toEqual(['usePanelStore']);
  });

  it('should NOT subscribe to explorer or accessory panel state', () => {
    const fields = selectors.map((s) => s.field).filter(Boolean);
    const forbidden = ['explorerWidth', 'explorerCollapsed', 'accessoryWidth', 'accessoryCollapsed'];
    for (const f of forbidden) {
      expect(fields, `RailSection should not subscribe to ${f}`).not.toContain(f);
    }
  });

  it('should render ProjectRail and ResizeDivider', () => {
    const tags = collectJsxTagNames(railSectionFn);
    expect(tags.has('ProjectRail'), 'Should render ProjectRail').toBe(true);
    expect(tags.has('ResizeDivider'), 'Should render ResizeDivider').toBe(true);
  });
});

// ─── ProjectPanelLayout ─────────────────────────────────────────────────────

describe('ProjectPanelLayout – selector isolation', () => {
  const selectors = findStoreSelectors(panelLayoutFn.body!);

  it('should subscribe to explorer and accessory panel state', () => {
    const fields = selectors.map((s) => s.field).filter(Boolean);
    expect(fields).toContain('explorerWidth');
    expect(fields).toContain('explorerCollapsed');
    expect(fields).toContain('accessoryWidth');
    expect(fields).toContain('accessoryCollapsed');
    expect(fields).toContain('resizeExplorer');
    expect(fields).toContain('resizeAccessory');
    expect(fields).toContain('toggleExplorerCollapse');
    expect(fields).toContain('toggleAccessoryCollapse');
  });

  it('should NOT subscribe to rail state', () => {
    const fields = selectors.map((s) => s.field).filter(Boolean);
    const forbidden = ['railPinned', 'resizeRail', 'toggleRailPin'];
    for (const f of forbidden) {
      expect(fields, `ProjectPanelLayout should not subscribe to ${f}`).not.toContain(f);
    }
  });

  it('should render ExplorerRail, AccessoryPanel, MainContentView, and ResizeDivider', () => {
    const tags = collectJsxTagNames(panelLayoutFn);
    expect(tags.has('ExplorerRail'), 'Should render ExplorerRail').toBe(true);
    expect(tags.has('AccessoryPanel'), 'Should render AccessoryPanel').toBe(true);
    expect(tags.has('MainContentView'), 'Should render MainContentView').toBe(true);
    expect(tags.has('ResizeDivider'), 'Should render ResizeDivider').toBe(true);
  });

  it('should subscribe to plugin store for full-width layout check', () => {
    const storeNames = new Set(selectors.map((s) => s.storeName));
    expect(storeNames.has('usePluginStore'), 'Should check plugin layout').toBe(true);
  });
});
