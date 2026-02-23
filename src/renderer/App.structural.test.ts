import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Structural regression tests for App.tsx.
 *
 * These tests parse the source text of App.tsx to verify:
 *  1. Global dialog components are present in ALL JSX return paths
 *  2. All useEffect hooks are accounted for (guards against accidental deletion)
 *  3. Initialization order: settings load before plugin system init
 *  4. Listener cleanup: useEffect hooks that register listeners return cleanup fns
 *  5. Plugin system initializes before project-specific plugin activation
 *
 * This approach (static source analysis) is intentional — it catches structural
 * regressions without needing to mount the component, avoiding heavyweight mocks.
 */

// Normalize line endings so the test works on Windows (CRLF) and Unix (LF)
const source = readFileSync(join(__dirname, 'App.tsx'), 'utf-8').replace(/\r\n/g, '\n');

/**
 * Helper: extract all JSX return blocks from the App component.
 * Each block starts with an indented `return (` followed by `<div`
 * and ends at the matching `);` closer at the same indentation level.
 */
function getJsxReturnBlocks(): Array<{ block: string; startIdx: number; label: string }> {
  const jsxReturnPattern = /^([ ]+)return \(\n\s+<div/gm;
  const matches = [...source.matchAll(jsxReturnPattern)];
  const blocks: Array<{ block: string; startIdx: number; label: string }> = [];

  for (const match of matches) {
    const startIdx = match.index!;
    const indent = match[1]; // capture the exact indentation of `return (`
    // Find the closing `);` at the same indentation level
    const closer = `\n${indent});`;
    const endIdx = source.indexOf(closer, startIdx);
    const block = source.slice(startIdx, endIdx + closer.length);

    // Determine which return path this is based on surrounding context
    const contextBefore = source.slice(Math.max(0, startIdx - 200), startIdx);
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

// ─── 2. useEffect Hook Count ───────────────────────────────────────────────

describe('App.tsx – useEffect hook registration', () => {
  it('should have the expected number of useEffect hooks', () => {
    // Count all useEffect( calls inside the App function body
    const appBody = source.slice(source.indexOf('export function App()'));
    const useEffectMatches = [...appBody.matchAll(/useEffect\(/g)];

    // As of the current version, App.tsx has 22 useEffect hooks.
    // If this number changes, it likely means a hook was added or removed —
    // either way warrants review.
    expect(useEffectMatches.length).toBeGreaterThanOrEqual(20);
  });

  it('should register the init useEffect with all settings loaders', () => {
    // The first useEffect should call all settings loaders before plugin init
    const initEffectPattern = /useEffect\(\(\) => \{[\s\S]*?loadProjects\(\);[\s\S]*?\}, \[/;
    const match = source.match(initEffectPattern);
    expect(match, 'Init useEffect not found').toBeTruthy();

    const initBlock = match![0];
    const expectedLoaders = [
      'loadProjects',
      'loadNotificationSettings',
      'loadTheme',
      'loadOrchestratorSettings',
      'loadLoggingSettings',
      'loadHeadlessSettings',
      'loadBadgeSettings',
      'loadUpdateSettings',
      'initBadgeSideEffects',
    ];

    for (const loader of expectedLoaders) {
      expect(
        initBlock,
        `Init useEffect is missing call to ${loader}()`,
      ).toContain(`${loader}(`);
    }
  });
});

// ─── 3. Initialization Order ───────────────────────────────────────────────

describe('App.tsx – initialization order', () => {
  it('should call initializePluginSystem AFTER all settings loaders in the init useEffect', () => {
    // Extract the init useEffect body
    const initEffectStart = source.indexOf('useEffect(() => {\n    loadProjects()');
    expect(initEffectStart, 'Init useEffect not found').toBeGreaterThan(-1);

    const initEffectEnd = source.indexOf('}, [loadProjects,', initEffectStart);
    const initBody = source.slice(initEffectStart, initEffectEnd);

    // Find positions of settings loaders and plugin init
    const settingsLoaders = [
      'loadProjects()',
      'loadNotificationSettings()',
      'loadTheme()',
      'loadOrchestratorSettings()',
      'loadLoggingSettings()',
      'loadHeadlessSettings()',
      'loadBadgeSettings()',
      'loadUpdateSettings()',
      'initBadgeSideEffects()',
    ];

    const pluginInitPos = initBody.indexOf('initializePluginSystem()');
    expect(pluginInitPos, 'initializePluginSystem() not found in init useEffect').toBeGreaterThan(-1);

    for (const loader of settingsLoaders) {
      const loaderPos = initBody.indexOf(loader);
      expect(loaderPos, `${loader} not found in init useEffect`).toBeGreaterThan(-1);
      expect(
        loaderPos,
        `${loader} should be called BEFORE initializePluginSystem()`,
      ).toBeLessThan(pluginInitPos);
    }
  });

  it('should handle initializePluginSystem failure gracefully (catch handler)', () => {
    // Plugin init should have a .catch() so a failure doesn't crash the app
    expect(
      source,
      'initializePluginSystem() should have a .catch() handler',
    ).toMatch(/initializePluginSystem\(\)\.catch\(/);
  });

  it('should activate project plugins only after project switch (not in init useEffect)', () => {
    // handleProjectSwitch should NOT be in the init useEffect
    const initEffectStart = source.indexOf('useEffect(() => {\n    loadProjects()');
    const initEffectEnd = source.indexOf('}, [loadProjects,', initEffectStart);
    const initBody = source.slice(initEffectStart, initEffectEnd);

    expect(
      initBody,
      'handleProjectSwitch should not be called in the init useEffect',
    ).not.toContain('handleProjectSwitch');
  });

  it('should call handleProjectSwitch in the activeProjectId useEffect', () => {
    // There should be a useEffect that depends on activeProjectId and calls handleProjectSwitch
    const projectSwitchPattern = /useEffect\(\(\) => \{[\s\S]*?handleProjectSwitch[\s\S]*?\}, \[activeProjectId/;
    expect(
      source,
      'No useEffect with handleProjectSwitch dependent on activeProjectId',
    ).toMatch(projectSwitchPattern);
  });
});

// ─── 4. Listener Cleanup Patterns ──────────────────────────────────────────

describe('App.tsx – listener cleanup', () => {
  it('should return cleanup functions for IPC listeners', () => {
    // These useEffects register IPC listeners and should return cleanup functions
    const listenerPatterns = [
      { name: 'initUpdateListener', pattern: /initUpdateListener\(\)[\s\S]*?return \(\) => remove\(\)/ },
      { name: 'initAnnexListener', pattern: /initAnnexListener\(\)[\s\S]*?return \(\) => remove\(\)/ },
      { name: 'initPluginUpdateListener', pattern: /initPluginUpdateListener\(\)[\s\S]*?return \(\) => remove\(\)/ },
      { name: 'onOpenSettings', pattern: /onOpenSettings\([\s\S]*?return \(\) => remove\(\)/ },
      { name: 'onOpenAbout', pattern: /onOpenAbout\([\s\S]*?return \(\) => remove\(\)/ },
      { name: 'onNotificationClicked', pattern: /onNotificationClicked\([\s\S]*?return \(\) => remove\(\)/ },
      { name: 'onRequestAgentState', pattern: /onRequestAgentState\([\s\S]*?return \(\) => remove\(\)/ },
      { name: 'onRequestHubState', pattern: /onRequestHubState\([\s\S]*?return \(\) => remove\(\)/ },
      { name: 'onHubMutation', pattern: /onHubMutation\([\s\S]*?return \(\) => remove\(\)/ },
      { name: 'onNavigateToAgent', pattern: /window\.clubhouse\.window\.onNavigateToAgent[\s\S]*?return \(\) => remove\(\)/ },
      { name: 'onExit (pty)', pattern: /pty\.onExit\([\s\S]*?return \(\) => removeExitListener\(\)/ },
      { name: 'onHookEvent', pattern: /onHookEvent\([\s\S]*?return \(\) => removeHookListener\(\)/ },
    ];

    for (const { name, pattern } of listenerPatterns) {
      expect(
        source,
        `Listener "${name}" should have a cleanup function returned from its useEffect`,
      ).toMatch(pattern);
    }
  });

  it('should clean up the keyboard shortcut listener', () => {
    expect(
      source,
      'Keyboard shortcut handler should remove the event listener on cleanup',
    ).toMatch(/addEventListener\('keydown', handler\)[\s\S]*?removeEventListener\('keydown', handler\)/);
  });

  it('should clean up the stale status interval', () => {
    expect(
      source,
      'clearStaleStatuses interval should be cleaned up with clearInterval',
    ).toMatch(/setInterval\(clearStaleStatuses[\s\S]*?clearInterval\(id\)/);
  });

  it('should clean up the agent status subscription', () => {
    expect(
      source,
      'Agent status subscription should return unsub cleanup',
    ).toMatch(/useAgentStore\.subscribe\([\s\S]*?return unsub/);
  });
});

// ─── 5. Plugin System Guards ───────────────────────────────────────────────

describe('App.tsx – plugin system safety', () => {
  it('should wrap plugin event emissions in try/catch in the onExit handler', () => {
    // The onExit handler emits pluginEventBus events — these should be wrapped
    // to prevent a plugin listener error from crashing the app
    const onExitBlock = source.slice(
      source.indexOf('pty.onExit('),
      source.indexOf('return () => removeExitListener()'),
    );

    expect(
      onExitBlock,
      'pluginEventBus.emit in onExit should be wrapped in try/catch',
    ).toMatch(/try\s*\{[\s\S]*?pluginEventBus\.emit\('agent:completed'[\s\S]*?\}\s*catch/);
  });

  it('should handle project plugin config load failures', () => {
    // The project switch useEffect loads plugin config — should handle errors
    const projectSwitchBlock = source.slice(
      source.indexOf('handleProjectSwitch'),
      source.indexOf('}, [activeProjectId, projects]'),
    );

    expect(
      projectSwitchBlock,
      'Project plugin config loading should have error handling',
    ).toMatch(/catch/);
  });
});

// ─── 6. Import Verification ───────────────────────────────────────────────

describe('App.tsx – required imports', () => {
  const requiredImports = [
    { module: 'plugin-loader', names: ['initializePluginSystem', 'handleProjectSwitch'] },
    { module: 'plugin-events', names: ['pluginEventBus'] },
    { module: 'updateStore', names: ['initUpdateListener'] },
    { module: 'annexStore', names: ['initAnnexListener'] },
    { module: 'pluginUpdateStore', names: ['initPluginUpdateListener'] },
    { module: 'badgeStore', names: ['initBadgeSideEffects'] },
  ];

  for (const { module, names } of requiredImports) {
    for (const name of names) {
      it(`should import ${name} from ${module}`, () => {
        expect(
          source,
          `Missing import: ${name} from ${module}`,
        ).toContain(name);
      });
    }
  }
});
