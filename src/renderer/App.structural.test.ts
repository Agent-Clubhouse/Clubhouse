import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Structural regression tests for App.tsx and its extracted modules.
 *
 * These tests parse the source text to verify:
 *  1. Global dialog components are present in ALL JSX return paths
 *  2. App.tsx subscribes only to layout-related store selectors
 *  3. Initialization order: settings load before plugin system init
 *  4. Listener cleanup: event bridge and initializer return cleanup fns
 *  5. Plugin system initializes before project-specific plugin activation
 *
 * This approach (static source analysis) is intentional — it catches structural
 * regressions without needing to mount the component, avoiding heavyweight mocks.
 */

// Normalize line endings so the test works on Windows (CRLF) and Unix (LF)
const appSource = readFileSync(join(__dirname, 'App.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const eventBridgeSource = readFileSync(join(__dirname, 'app-event-bridge.ts'), 'utf-8').replace(/\r\n/g, '\n');
const initializerSource = readFileSync(join(__dirname, 'app-initializer.ts'), 'utf-8').replace(/\r\n/g, '\n');

/**
 * Helper: extract all JSX return blocks from the App component.
 * Each block starts with an indented `return (` followed by `<div`
 * and ends at the matching `);` closer at the same indentation level.
 */
function getJsxReturnBlocks(): Array<{ block: string; startIdx: number; label: string }> {
  const jsxReturnPattern = /^([ ]+)return \(\n\s+<div/gm;
  const matches = [...appSource.matchAll(jsxReturnPattern)];
  const blocks: Array<{ block: string; startIdx: number; label: string }> = [];

  for (const match of matches) {
    const startIdx = match.index!;
    const indent = match[1]; // capture the exact indentation of `return (`
    // Find the closing `);` at the same indentation level
    const closer = `\n${indent});`;
    const endIdx = appSource.indexOf(closer, startIdx);
    const block = appSource.slice(startIdx, endIdx + closer.length);

    // Determine which return path this is based on surrounding context
    const contextBefore = appSource.slice(Math.max(0, startIdx - 200), startIdx);
    let label = 'unknown';
    if (contextBefore.includes('if (isHome)')) label = 'Home';
    else if (contextBefore.includes('if (isAppPlugin)')) label = 'AppPlugin';
    else if (contextBefore.includes('if (isHelp)')) label = 'Help';
    else label = 'MainProject';

    blocks.push({ block, startIdx, label });
  }

  return blocks;
}

// ─── 1. Global Dialog Presence ─────────────────────────────────────────────

describe('App.tsx – global dialog presence in all return paths', () => {
  const blocks = getJsxReturnBlocks();

  it('should have exactly 4 JSX return blocks (Home, AppPlugin, Help, MainProject)', () => {
    expect(blocks.length).toBe(4);
    const labels = blocks.map((b) => b.label).sort();
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
      for (const { block, label } of blocks) {
        expect(
          block,
          `${label} return path is missing <${dialog} />`,
        ).toContain(`<${dialog}`);
      }
    });
  }

  // Additional dialogs that should also be in every return path
  const additionalGlobalComponents = [
    'WhatsNewDialog',
    'OnboardingModal',
    'PermissionViolationBanner',
    'UpdateBanner',
  ];

  for (const component of additionalGlobalComponents) {
    it(`should include <${component} /> in every JSX return block`, () => {
      for (const { block, label } of blocks) {
        expect(
          block,
          `${label} return path is missing <${component} />`,
        ).toContain(`<${component}`);
      }
    });
  }
});

// ─── 2. Selector Count (App.tsx should be lean) ────────────────────────────

describe('App.tsx – selector discipline', () => {
  it('should have at most 15 store selector calls (layout-only)', () => {
    const appBody = appSource.slice(appSource.indexOf('export function App()'));
    // Count useXxxStore((s) => ...) calls
    const selectorCalls = [...appBody.matchAll(/use\w+Store\(\(s\)/g)];
    expect(selectorCalls.length).toBeLessThanOrEqual(15);
  });

  it('should NOT subscribe to agentStore for event handler functions', () => {
    const appBody = appSource.slice(appSource.indexOf('export function App()'));
    // These function selectors were moved to app-event-bridge.ts
    const removedSelectors = [
      'updateAgentStatus',
      'handleHookEvent',
      'clearStaleStatuses',
      'removeAgent',
    ];
    for (const sel of removedSelectors) {
      expect(
        appBody,
        `App.tsx should not subscribe to agentStore.${sel} (moved to event bridge)`,
      ).not.toMatch(new RegExp(`useAgentStore\\(\\(s\\)\\s*=>\\s*s\\.${sel}\\)`));
    }
  });

  it('should NOT subscribe to initialization-only stores', () => {
    const appBody = appSource.slice(appSource.indexOf('export function App()'));
    // These stores were only used for initialization — now in app-initializer.ts
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
    for (const store of removedStores) {
      expect(
        appBody,
        `App.tsx should not import ${store} (moved to initializer/event bridge)`,
      ).not.toContain(`${store}(`);
    }
  });
});

// ─── 3. App.tsx useEffect count (should be minimal) ────────────────────────

describe('App.tsx – useEffect hook registration', () => {
  it('should have minimal useEffect hooks (init + reactive effects only)', () => {
    const appBody = appSource.slice(appSource.indexOf('export function App()'));
    const useEffectMatches = [...appBody.matchAll(/useEffect\(/g)];
    // After refactor: 1 (init+bridge) + 1 (load durable) + 1 (load completed) + 1 (project switch) = 4
    expect(useEffectMatches.length).toBeGreaterThanOrEqual(3);
    expect(useEffectMatches.length).toBeLessThanOrEqual(6);
  });

  it('should initialize via initApp and initAppEventBridge', () => {
    expect(appSource).toContain('initApp()');
    expect(appSource).toContain('initAppEventBridge()');
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

    const pluginInitPos = initializerSource.indexOf('initializePluginSystem()');
    expect(pluginInitPos, 'initializePluginSystem() not found').toBeGreaterThan(-1);

    for (const loader of expectedLoaders) {
      const loaderPos = initializerSource.indexOf(loader);
      expect(loaderPos, `${loader} not found in initializer`).toBeGreaterThan(-1);
      expect(
        loaderPos,
        `${loader} should be called BEFORE initializePluginSystem()`,
      ).toBeLessThan(pluginInitPos);
    }
  });

  it('should handle initializePluginSystem failure gracefully (catch handler)', () => {
    expect(
      initializerSource,
      'initializePluginSystem() should have a .catch() handler',
    ).toMatch(/initializePluginSystem\(\)\.catch\(/);
  });

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
  it('should register all IPC listeners', () => {
    const expectedListeners = [
      'onOpenSettings',
      'onOpenAbout',
      'onNotificationClicked',
      'onRequestAgentState',
      'onRequestHubState',
      'onHubMutation',
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
    const onExitBlock = eventBridgeSource.slice(
      eventBridgeSource.indexOf('pty.onExit('),
      eventBridgeSource.indexOf('return removeExitListener'),
    );

    expect(
      onExitBlock,
      'pluginEventBus.emit in onExit should be wrapped in try/catch',
    ).toMatch(/try\s*\{[\s\S]*?pluginEventBus\.emit\('agent:completed'[\s\S]*?\}\s*catch/);
  });

  it('should use getState() instead of hooks for all store access', () => {
    // The event bridge should never use React hooks
    expect(eventBridgeSource).not.toMatch(/\buseEffect\b/);
    expect(eventBridgeSource).not.toMatch(/\buseState\b/);
    expect(eventBridgeSource).not.toMatch(/\buseRef\b/);
  });
});

// ─── 6. Project Switch (still in App.tsx) ──────────────────────────────────

describe('App.tsx – project switch handling', () => {
  it('should call handleProjectSwitch in the activeProjectId useEffect', () => {
    const projectSwitchPattern = /useEffect\(\(\) => \{[\s\S]*?handleProjectSwitch[\s\S]*?\}, \[activeProjectId/;
    expect(
      appSource,
      'No useEffect with handleProjectSwitch dependent on activeProjectId',
    ).toMatch(projectSwitchPattern);
  });

  it('should handle project plugin config load failures', () => {
    const projectSwitchBlock = appSource.slice(
      appSource.indexOf('handleProjectSwitch'),
      appSource.indexOf('}, [activeProjectId, projects]'),
    );

    expect(
      projectSwitchBlock,
      'Project plugin config loading should have error handling',
    ).toMatch(/catch/);
  });
});

// ─── 7. Import Verification ───────────────────────────────────────────────

describe('App.tsx – required imports', () => {
  it('should import initApp and initAppEventBridge', () => {
    expect(appSource).toContain("from './app-initializer'");
    expect(appSource).toContain("from './app-event-bridge'");
  });

  it('should import handleProjectSwitch from plugin-loader', () => {
    expect(appSource).toContain('handleProjectSwitch');
  });
});

describe('app-event-bridge.ts – required imports', () => {
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
      expect(
        eventBridgeSource,
        `Missing import: ${name}`,
      ).toContain(name);
    });
  }
});

describe('app-initializer.ts – required imports', () => {
  const requiredImports = [
    'initializePluginSystem',
    'initUpdateListener',
    'initAnnexListener',
    'initPluginUpdateListener',
    'initBadgeSideEffects',
  ];

  for (const name of requiredImports) {
    it(`should import ${name}`, () => {
      expect(
        initializerSource,
        `Missing import: ${name}`,
      ).toContain(name);
    });
  }
});
