import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * Structural regression tests for App.tsx and its extracted modules.
 *
 * These tests use TypeScript's compiler API to parse source files into ASTs,
 * making them resilient to formatting changes (whitespace, indentation, line
 * breaks) while still catching structural regressions without mounting the
 * component or requiring heavyweight mocks.
 *
 * What these tests verify:
 *  1. Global dialog components are present in ALL JSX return paths
 *  2. App.tsx subscribes only to layout-related store selectors
 *  3. Minimal useEffect hooks (initialization + reactive effects)
 *  4. Initialization order: settings load before plugin system init
 *  5. Event bridge uses getState() and subscribe(), never React hooks
 *  6. Project switch handling includes error recovery
 *
 * Why structural tests (not runtime)?
 * These modules orchestrate many stores, IPC handlers, and side effects.
 * Full runtime testing would require mocking the entire Electron/Zustand
 * environment. Structural tests verify the _wiring_ is correct — that
 * the right functions are called in the right order — without that cost.
 */

// ─── AST Helpers ────────────────────────────────────────────────────────────

/** Parse a TypeScript/TSX file into an AST with parent pointers. */
function parseFile(filePath: string): ts.SourceFile {
  const source = readFileSync(filePath, 'utf-8');
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Find a top-level function declaration by name. */
function findNamedFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return stmt;
    }
  }
  return undefined;
}

/** Collect all JSX tag names (opening and self-closing elements) within a node. */
function collectJsxTagNames(node: ts.Node): Set<string> {
  const tags = new Set<string>();
  function visit(n: ts.Node) {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (ts.isIdentifier(n.tagName)) {
        tags.add(n.tagName.text);
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return tags;
}

interface ReturnPathInfo {
  label: string;
  tagNames: Set<string>;
}

const CONDITION_LABELS: Record<string, string> = {
  isHome: 'Home',
  isAppPlugin: 'AppPlugin',
  isHelp: 'Help',
};

/**
 * Find all direct return statements in the App function body (skipping nested
 * functions/arrows). Labels each return path by its containing if-statement's
 * condition identifier (e.g. `if (isHome)` → label 'Home').
 */
function findReturnPaths(funcDecl: ts.FunctionDeclaration): ReturnPathInfo[] {
  const paths: ReturnPathInfo[] = [];

  function visit(node: ts.Node, label: string) {
    if (ts.isReturnStatement(node)) {
      const tagNames = node.expression ? collectJsxTagNames(node.expression) : new Set<string>();
      paths.push({ label, tagNames });
      return;
    }
    // Skip nested functions — their returns belong to inner scope
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      return;
    }
    // Derive label from if-statement condition
    if (ts.isIfStatement(node)) {
      let ifLabel = label;
      if (ts.isIdentifier(node.expression) && CONDITION_LABELS[node.expression.text]) {
        ifLabel = CONDITION_LABELS[node.expression.text];
      }
      visit(node.thenStatement, ifLabel);
      if (node.elseStatement) visit(node.elseStatement, label);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, label));
  }

  if (funcDecl.body) {
    ts.forEachChild(funcDecl.body, (child) => visit(child, 'MainProject'));
  }
  return paths;
}

/**
 * Find all store selector calls (use*Store((s) => ...)) in a function body.
 * Skips nested functions/arrows to only count direct-scope selectors.
 */
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
    // Skip nested functions
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(funcBody, visit);
  return selectors;
}

/**
 * Count call expressions matching a callee name in a function body.
 * Skips nested functions/arrows.
 */
function countCallsInBody(funcBody: ts.Block, calleeName: string): number {
  let count = 0;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) {
      count++;
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(funcBody, visit);
  return count;
}

/** Check if any descendant of a node contains a given identifier. */
function containsIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) found = containsIdentifier(child, name);
  });
  return found;
}

/** Check if any descendant contains a catch clause or .catch() call. */
function containsCatch(node: ts.Node): boolean {
  if (ts.isCatchClause(node)) return true;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'catch') return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) found = containsCatch(child);
  });
  return found;
}

/**
 * Find a useEffect call in a function body whose callback contains a specific
 * identifier and whose deps array contains a specific dependency.
 */
function findUseEffectWithDep(funcBody: ts.Block, callbackIdent: string, dep: string): boolean {
  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const hasIdent = containsIdentifier(callback, callbackIdent);
        const deps = node.arguments[1];
        if (deps && ts.isArrayLiteralExpression(deps)) {
          const hasDep = deps.elements.some((e) => ts.isIdentifier(e) && e.text === dep);
          if (hasIdent && hasDep) {
            found = true;
            return;
          }
        }
      }
    }
    // Don't recurse into nested functions
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(funcBody, visit);
  return found;
}

/** Find all imported identifiers in a source file. */
function findImportedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      if (stmt.importClause.name) names.add(stmt.importClause.name.text);
      if (stmt.importClause.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
        for (const spec of stmt.importClause.namedBindings.elements) {
          names.add(spec.name.text);
        }
      }
    }
  }
  return names;
}

/** Find all import module specifiers in a source file. */
function findImportModules(sf: ts.SourceFile): Set<string> {
  const modules = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      modules.add(stmt.moduleSpecifier.text);
    }
  }
  return modules;
}

/**
 * Find the AST position of the first call expression that includes a given
 * identifier in its callee chain. Returns -1 if not found.
 */
function findFirstCallPosition(sf: ts.SourceFile, name: string): number {
  let pos = -1;
  function visit(node: ts.Node) {
    if (pos !== -1) return;
    if (ts.isCallExpression(node) && containsIdentifier(node.expression, name)) {
      pos = node.getStart(sf);
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return pos;
}

/**
 * Check if a function body contains a try-catch block that wraps a
 * specific method call (e.g. pluginEventBus.emit('agent:completed')).
 */
function hasTryCatchAround(
  funcBody: ts.Block,
  target: { object: string; method: string; firstArg: string },
): boolean {
  let found = false;

  function hasTargetCall(node: ts.Node): boolean {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      if (ts.isIdentifier(prop.expression) && prop.expression.text === target.object
          && prop.name.text === target.method
          && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
          && node.arguments[0].text === target.firstArg) {
        return true;
      }
    }
    let result = false;
    ts.forEachChild(node, (child) => {
      if (!result) result = hasTargetCall(child);
    });
    return result;
  }

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isTryStatement(node) && node.catchClause && hasTargetCall(node.tryBlock)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(funcBody, visit);
  return found;
}

// ─── Parse Source Files ─────────────────────────────────────────────────────

const appAst = parseFile(join(__dirname, 'App.tsx'));
const eventBridgeAst = parseFile(join(__dirname, 'app-event-bridge.ts'));
const initializerAst = parseFile(join(__dirname, 'app-initializer.ts'));

const appFn = findNamedFunction(appAst, 'App')!;

// For simple, formatting-resilient presence checks (identifier names don't
// change with formatters — these are safe as plain string contains).
const eventBridgeSource = readFileSync(join(__dirname, 'app-event-bridge.ts'), 'utf-8');
const initializerSource = readFileSync(join(__dirname, 'app-initializer.ts'), 'utf-8');

// ─── 1. Global Dialog Presence ─────────────────────────────────────────────

describe('App.tsx – global dialog presence in all return paths', () => {
  const returnPaths = findReturnPaths(appFn);

  it('should have exactly 4 JSX return blocks (Home, AppPlugin, Help, MainProject)', () => {
    expect(returnPaths.length).toBe(4);
    const labels = returnPaths.map((p) => p.label).sort();
    expect(labels).toEqual(['AppPlugin', 'Help', 'Home', 'MainProject']);
  });

  const requiredDialogs = [
    'QuickAgentDialog',
    'CommandPalette',
    'ConfigChangesDialog',
    'PluginUpdateBanner',
  ];

  for (const dialog of requiredDialogs) {
    it(`should include <${dialog} /> in every JSX return block`, () => {
      for (const { tagNames, label } of returnPaths) {
        expect(
          tagNames.has(dialog),
          `${label} return path is missing <${dialog} />`,
        ).toBe(true);
      }
    });
  }

  const additionalGlobalComponents = [
    'WhatsNewDialog',
    'OnboardingModal',
    'PermissionViolationBanner',
    'UpdateBanner',
    'ToastContainer',
  ];

  for (const component of additionalGlobalComponents) {
    it(`should include <${component} /> in every JSX return block`, () => {
      for (const { tagNames, label } of returnPaths) {
        expect(
          tagNames.has(component),
          `${label} return path is missing <${component} />`,
        ).toBe(true);
      }
    });
  }
});

// ─── 2. Selector Count (App.tsx should be lean) ────────────────────────────

describe('App.tsx – selector discipline', () => {
  const selectors = findStoreSelectors(appFn.body!);

  it('should have at most 12 store selector calls (routing + lock state)', () => {
    // After extracting TitleBar, RailSection, and ProjectPanelLayout:
    // projects, activeProjectId, explorerTab = 3 selectors
    // Annex V2 lock state: locked, paused, alias, icon, color, fingerprint, togglePause, unlock = 8 selectors
    // Individual selectors avoid Zustand reference-inequality re-render loops
    expect(selectors.length).toBeLessThanOrEqual(12);
  });

  it('should NOT subscribe to agentStore for event handler functions', () => {
    const removedSelectors = [
      'updateAgentStatus',
      'handleHookEvent',
      'clearStaleStatuses',
      'removeAgent',
    ];
    const agentSelectors = selectors
      .filter((s) => s.storeName === 'useAgentStore')
      .map((s) => s.field)
      .filter(Boolean);
    for (const sel of removedSelectors) {
      expect(
        agentSelectors,
        `App.tsx should not subscribe to agentStore.${sel} (moved to event bridge)`,
      ).not.toContain(sel);
    }
  });

  it('should NOT subscribe to initialization-only stores', () => {
    const removedStores = [
      'useThemeStore',
      'useOrchestratorStore',
      'useLoggingStore',
      'useHeadlessStore',
      'useBadgeSettingsStore',
      'useOnboardingStore',
      'useUpdateStore',
      'useNotificationStore',
    ];
    const usedStores = new Set(selectors.map((s) => s.storeName));
    for (const store of removedStores) {
      expect(
        usedStores.has(store),
        `App.tsx should not subscribe to ${store} (moved to initializer/event bridge)`,
      ).toBe(false);
    }
  });
});

// ─── 3. App.tsx useEffect count (should be minimal) ────────────────────────

describe('App.tsx – useEffect hook registration', () => {
  it('should have minimal useEffect hooks (init + reactive effects only)', () => {
    const count = countCallsInBody(appFn.body!, 'useEffect');
    // After refactor: 1 (init+bridge) + 1 (load durable) + 1 (load completed) + 1 (project switch) = 4
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(6);
  });

  it('should initialize via initApp and initAppEventBridge', () => {
    const imports = findImportedNames(appAst);
    expect(imports.has('initApp'), 'initApp should be imported').toBe(true);
    expect(imports.has('initAppEventBridge'), 'initAppEventBridge should be imported').toBe(true);
  });
});

// ─── 4. Initializer Module ─────────────────────────────────────────────────

describe('app-initializer.ts – initialization order', () => {
  it('should call all settings loaders before plugin system init', () => {
    const expectedLoaders = [
      'loadProjects',
      'loadSettings', // notification, orchestrator, logging, headless, badge, update stores
      'loadTheme',
      'initBadgeSideEffects',
    ];

    const pluginInitPos = findFirstCallPosition(initializerAst, 'initializePluginSystem');
    expect(pluginInitPos, 'initializePluginSystem() not found').toBeGreaterThan(-1);

    for (const loader of expectedLoaders) {
      const loaderPos = findFirstCallPosition(initializerAst, loader);
      expect(loaderPos, `${loader} not found in initializer`).toBeGreaterThan(-1);
      expect(
        loaderPos,
        `${loader} should be called BEFORE initializePluginSystem()`,
      ).toBeLessThan(pluginInitPos);
    }
  });

  it('should handle initializePluginSystem failure gracefully (catch handler)', () => {
    // Verify the AST has a .catch() call chained to initializePluginSystem()
    let found = false;
    function visit(node: ts.Node) {
      if (found) return;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const prop = node.expression;
        if (prop.name.text === 'catch' && ts.isCallExpression(prop.expression)
            && containsIdentifier(prop.expression, 'initializePluginSystem')) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(initializerAst, visit);
    expect(found, 'initializePluginSystem() should have a .catch() handler').toBe(true);
  });

  // Simple presence checks — these identifier names are formatting-resilient
  it('should set up update, annex, and plugin-update listeners', () => {
    expect(initializerSource).toContain('initUpdateListener()');
    expect(initializerSource).toContain('initAnnexListener()');
    expect(initializerSource).toContain('initPluginUpdateListener()');
  });

  it('should handle What\'s New and onboarding checks', () => {
    expect(initializerSource).toContain('checkWhatsNew()');
    expect(initializerSource).toContain('startOnboarding()');
  });
});

// ─── 5. Event Bridge Module ────────────────────────────────────────────────

describe('app-event-bridge.ts – listener registration', () => {
  // Simple identifier presence checks — resilient to formatting
  it('should register all IPC listeners', () => {
    const expectedListeners = [
      'onOpenSettings',
      'onOpenAbout',
      'onNotificationClicked',
      'onRequestAgentState',
      'onRequestHubState',
      'onHubMutation',
      'onRequestCanvasState',
      'onCanvasMutation',
      'onNavigateToAgent',
    ];

    for (const listener of expectedListeners) {
      expect(
        eventBridgeSource,
        `Event bridge should register ${listener}`,
      ).toContain(listener);
    }
  });

  it('should register agent lifecycle listeners', () => {
    expect(eventBridgeSource).toContain('pty.onExit(');
    expect(eventBridgeSource).toContain('onHookEvent(');
    expect(eventBridgeSource).toContain('onAgentSpawned(');
  });

  it('should set up keyboard shortcut dispatcher', () => {
    expect(eventBridgeSource).toContain("addEventListener('keydown'");
    expect(eventBridgeSource).toContain("removeEventListener('keydown'");
  });

  it('should set up stale status cleanup interval', () => {
    expect(eventBridgeSource).toContain('clearStaleStatuses');
    expect(eventBridgeSource).toContain('setInterval');
    expect(eventBridgeSource).toContain('clearInterval');
  });

  it('should set up agent status change emitter for plugins', () => {
    expect(eventBridgeSource).toContain('useAgentStore.subscribe');
    expect(eventBridgeSource).toContain("pluginEventBus.emit('agent:status-changed'");
  });

  it('should wrap plugin event emissions in try/catch in the PTY exit handler', () => {
    const exitFn = findNamedFunction(eventBridgeAst, 'initPtyExitListener');
    expect(exitFn, 'initPtyExitListener function not found').toBeDefined();
    expect(
      hasTryCatchAround(exitFn!.body!, {
        object: 'pluginEventBus',
        method: 'emit',
        firstArg: 'agent:completed',
      }),
      'pluginEventBus.emit(\'agent:completed\') in onExit should be wrapped in try/catch',
    ).toBe(true);
  });

  it('should use getState() instead of hooks for all store access', () => {
    // Check AST imports — the event bridge should never import React hooks
    const imports = findImportedNames(eventBridgeAst);
    const reactHooks = ['useEffect', 'useState', 'useRef'];
    for (const hook of reactHooks) {
      expect(imports.has(hook), `Event bridge should not import ${hook}`).toBe(false);
    }
  });
});

// ─── 6. Project Switch (still in App.tsx) ──────────────────────────────────

describe('App.tsx – project switch handling', () => {
  it('should call handleProjectSwitch in the activeProjectId useEffect', () => {
    expect(
      findUseEffectWithDep(appFn.body!, 'handleProjectSwitch', 'activeProjectId'),
      'No useEffect with handleProjectSwitch dependent on activeProjectId',
    ).toBe(true);
  });

  it('should handle project plugin config load failures', () => {
    // Find the useEffect with handleProjectSwitch and verify it contains catch handling
    let found = false;
    function visit(node: ts.Node) {
      if (found) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') {
        const callback = node.arguments[0];
        if (callback && ts.isArrowFunction(callback) && containsIdentifier(callback, 'handleProjectSwitch')) {
          if (containsCatch(callback)) {
            found = true;
            return;
          }
        }
      }
      // Don't recurse into nested functions
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(appFn.body!, visit);
    expect(found, 'Project plugin config loading should have error handling').toBe(true);
  });
});

// ─── 7. Import Verification ───────────────────────────────────────────────

describe('App.tsx – required imports', () => {
  const appImports = findImportedNames(appAst);
  const appModules = findImportModules(appAst);

  it('should import initApp and initAppEventBridge', () => {
    expect(appModules.has('./app-initializer'), "Missing import from './app-initializer'").toBe(true);
    expect(appModules.has('./app-event-bridge'), "Missing import from './app-event-bridge'").toBe(true);
  });

  it('should import handleProjectSwitch from plugin-loader', () => {
    expect(appImports.has('handleProjectSwitch'), 'Missing import: handleProjectSwitch').toBe(true);
  });
});

describe('app-event-bridge.ts – required imports', () => {
  const bridgeImports = findImportedNames(eventBridgeAst);
  const requiredImports = [
    'pluginEventBus',
    'consumeCancelled',
    'eventToBinding',
    'getCommandActions',
    'pluginHotkeyRegistry',
    'applyHubMutation',
  ];

  for (const name of requiredImports) {
    it(`should import ${name}`, () => {
      expect(bridgeImports.has(name), `Missing import: ${name}`).toBe(true);
    });
  }
});

describe('app-initializer.ts – required imports', () => {
  const initImports = findImportedNames(initializerAst);
  const requiredImports = [
    'initializePluginSystem',
    'initUpdateListener',
    'initAnnexListener',
    'initPluginUpdateListener',
    'initBadgeSideEffects',
  ];

  for (const name of requiredImports) {
    it(`should import ${name}`, () => {
      expect(initImports.has(name), `Missing import: ${name}`).toBe(true);
    });
  }
});
