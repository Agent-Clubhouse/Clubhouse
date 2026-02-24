/**
 * Zustand Selector Safety Tests
 *
 * These tests prevent reintroduction of infinite re-render loops caused by
 * Zustand selectors returning new object/array references on every call.
 *
 * The pattern: `useStore(s => s.getSomething())` where `getSomething()` returns
 * a new array/object each time causes React to re-render infinitely because
 * Zustand uses `Object.is` equality by default.
 *
 * This bug class is rated CRITICAL — it causes blank screens with 100% CPU
 * and requires force-quit. It has been fixed 3 times already.
 *
 * @see ReleasePrep/02-risk-areas-and-gaps.md §1
 * @see ReleasePrep/03-test-improvements.md §2
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { useBadgeSettingsStore } from '../badgeSettingsStore';
import { useBadgeStore } from '../badgeStore';
import { useOrchestratorStore } from '../orchestratorStore';
import { useQuickAgentStore } from '../quickAgentStore';
import { useAgentStore } from '../agentStore';


// ── Helpers ──────────────────────────────────────────────────────────────

/** Assert that calling a getter twice without mutations returns the same ref */
function expectStableRef<T>(getter: () => T, _label: string): void {
  const ref1 = getter();
  const ref2 = getter();
  expect(ref1).toBe(ref2); // Object.is equality — same as Zustand's default
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Reset badgeSettingsStore
  useBadgeSettingsStore.setState({
    enabled: true,
    pluginBadges: true,
    projectRailBadges: true,
    projectOverrides: {},
  });

  // Reset badgeStore
  useBadgeStore.setState({ badges: {} });

  // Reset orchestratorStore
  useOrchestratorStore.setState({
    enabled: ['claude-code'],
    allOrchestrators: [],
    availability: {},
  });

  // Reset quickAgentStore
  useQuickAgentStore.setState({
    completedAgents: {},
    selectedCompletedId: null,
  });
});

// ── 1. Referential stability: state properties ──────────────────────────

describe('Zustand selector safety — state property stability', () => {
  it('orchestratorStore.enabled returns same ref on repeated access', () => {
    expectStableRef(
      () => useOrchestratorStore.getState().enabled,
      'orchestratorStore.enabled',
    );
  });

  it('orchestratorStore.allOrchestrators returns same ref on repeated access', () => {
    expectStableRef(
      () => useOrchestratorStore.getState().allOrchestrators,
      'orchestratorStore.allOrchestrators',
    );
  });

  it('orchestratorStore.availability returns same ref on repeated access', () => {
    expectStableRef(
      () => useOrchestratorStore.getState().availability,
      'orchestratorStore.availability',
    );
  });

  it('quickAgentStore.completedAgents returns same ref on repeated access', () => {
    expectStableRef(
      () => useQuickAgentStore.getState().completedAgents,
      'quickAgentStore.completedAgents',
    );
  });

  it('agentStore.agents returns same ref on repeated access', () => {
    expectStableRef(
      () => useAgentStore.getState().agents,
      'agentStore.agents',
    );
  });

  it('agentStore.agentDetailedStatus returns same ref on repeated access', () => {
    expectStableRef(
      () => useAgentStore.getState().agentDetailedStatus,
      'agentStore.agentDetailedStatus',
    );
  });

  it('badgeStore.badges returns same ref on repeated access', () => {
    expectStableRef(
      () => useBadgeStore.getState().badges,
      'badgeStore.badges',
    );
  });
});

// ── 2. Referential stability: getter methods ────────────────────────────

describe('Zustand selector safety — getter method stability', () => {
  describe('badgeSettingsStore.getProjectSettings', () => {
    it('returns same ref on repeated calls without mutations', () => {
      useBadgeSettingsStore.setState({
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
        projectOverrides: { proj1: { enabled: false } },
      });

      expectStableRef(
        () => useBadgeSettingsStore.getState().getProjectSettings('proj1'),
        'getProjectSettings(proj1)',
      );
    });

    it('returns same ref for project without overrides', () => {
      expectStableRef(
        () => useBadgeSettingsStore.getState().getProjectSettings('no-overrides'),
        'getProjectSettings(no-overrides)',
      );
    });

    it('returns new ref after mutation', () => {
      const ref1 = useBadgeSettingsStore.getState().getProjectSettings('proj1');
      useBadgeSettingsStore.setState({ enabled: false });
      const ref2 = useBadgeSettingsStore.getState().getProjectSettings('proj1');
      expect(ref1).not.toBe(ref2);
      expect(ref2.enabled).toBe(false);
    });
  });

  describe('orchestratorStore.getCapabilities', () => {
    it('returns same ref on repeated calls without mutations', () => {
      const caps = { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true };
      useOrchestratorStore.setState({
        allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code', capabilities: caps }],
      });

      expectStableRef(
        () => useOrchestratorStore.getState().getCapabilities('claude-code'),
        'getCapabilities(claude-code)',
      );
    });
  });

  describe('badgeStore.getTabBadge', () => {
    it('returns same ref on repeated calls without mutations (with badges)', () => {
      useBadgeStore.getState().setBadge('core:test', 'count', 3, {
        kind: 'explorer-tab',
        projectId: 'proj1',
        tabId: 'tab1',
      });

      expectStableRef(
        () => useBadgeStore.getState().getTabBadge('proj1', 'tab1'),
        'getTabBadge(proj1, tab1)',
      );
    });

    it('returns same ref on repeated calls without mutations (no badges)', () => {
      expectStableRef(
        () => useBadgeStore.getState().getTabBadge('proj1', 'tab1'),
        'getTabBadge(proj1, tab1) — empty',
      );
    });
  });

  describe('badgeStore.getProjectBadge', () => {
    it('returns same ref on repeated calls without mutations', () => {
      useBadgeSettingsStore.setState({
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
        projectOverrides: {},
      });

      useBadgeStore.getState().setBadge('core:test', 'dot', 1, {
        kind: 'explorer-tab',
        projectId: 'proj1',
        tabId: 'tab1',
      });

      expectStableRef(
        () => useBadgeStore.getState().getProjectBadge('proj1'),
        'getProjectBadge(proj1)',
      );
    });
  });

  describe('badgeStore.getAppPluginBadge', () => {
    it('returns same ref on repeated calls without mutations', () => {
      useBadgeSettingsStore.setState({
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
        projectOverrides: {},
      });

      useBadgeStore.getState().setBadge('plugin:test', 'count', 5, {
        kind: 'app-plugin',
        pluginId: 'my-plugin',
      });

      expectStableRef(
        () => useBadgeStore.getState().getAppPluginBadge('my-plugin'),
        'getAppPluginBadge(my-plugin)',
      );
    });
  });
});

// ── 3. quickAgentStore: || [] fallback safety ───────────────────────────

describe('Zustand selector safety — quickAgentStore fallback patterns', () => {
  it('completedAgents[projectId] access returns same ref when project exists', () => {
    useQuickAgentStore.setState({
      completedAgents: { proj1: [] },
    });

    const ref1 = useQuickAgentStore.getState().completedAgents['proj1'];
    const ref2 = useQuickAgentStore.getState().completedAgents['proj1'];
    expect(ref1).toBe(ref2);
  });

  it('completedAgents[projectId] returns undefined (not new []) for missing project', () => {
    // Selectors should use a module-level EMPTY constant for the fallback,
    // NOT inline `|| []` which creates a new array each render.
    const result = useQuickAgentStore.getState().completedAgents['nonexistent'];
    expect(result).toBeUndefined();
  });
});

// ── 4. Static analysis: dangerous selector patterns ─────────────────────

describe('Zustand selector safety — static analysis guard', () => {
  const srcDir = path.resolve(__dirname, '../../..');
  const rendererDir = path.join(srcDir, 'renderer');

  /**
   * Scan TypeScript/TSX files for patterns that call store getter methods
   * directly inside a Zustand selector callback. This creates new
   * object/array references on every render, causing infinite loops.
   *
   * Dangerous: useXxxStore(s => s.getTabBadge(...))
   * Safe:      useXxxStore(s => s.badges)
   * Safe:      useXxxStore.getState().getTabBadge(...)
   */
  it('no component selectors call getter methods that return new objects', () => {
    // Match useXxxStore(s => s.method(...)) but NOT useSyncExternalStore or
    // other React hooks that happen to contain "Store" in the name.
    const storeMethodPattern =
      /use(?!SyncExternalStore)\w+Store\(\s*(?:\([^)]*\)|[a-z_$]\w*)\s*=>\s*(?:\([^)]*\)|[a-z_$]\w*)\.\w+\(/g;

    // Known safe: selectors that extract a function reference (e.g. s.loadSettings)
    // are safe because function refs are stable in Zustand state.
    // We need to distinguish `s => s.method(args)` (call — dangerous) from
    // `s => s.method` (reference — safe). The regex above already requires `(`.

    const violations: string[] = [];

    function scanDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip test directories and node_modules
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          scanDir(fullPath);
        } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.includes('.test.')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          let match: RegExpExecArray | null;
          while ((match = storeMethodPattern.exec(content)) !== null) {
            // Get line number for the match
            const before = content.slice(0, match.index);
            const line = before.split('\n').length;
            const relPath = path.relative(rendererDir, fullPath);
            violations.push(`${relPath}:${line}: ${match[0]}`);
          }
        }
      }
    }

    scanDir(rendererDir);

    if (violations.length > 0) {
      throw new Error(
        'Dangerous Zustand selector pattern detected! ' +
        'Calling a store getter method inside a selector creates new references on every render, ' +
        'causing infinite re-render loops.\n\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n') +
        '\n\nFix: Access the data outside the selector, or use `useStore.getState().method()` ' +
        'for one-off reads, or select the underlying state and compute in the component.',
      );
    }
  });

  /**
   * Scan for non-destructured `const x = useXxxStore()` calls.
   * Assigning the entire store to a single variable is almost always a
   * mistake — the variable is then used as a useMemo/useCallback dependency
   * which breaks memoization (Zustand returns a new top-level reference
   * after every setState call).
   *
   * Dangerous: const badgeSettings = useBadgeSettingsStore();
   * Safe:      const enabled = useBadgeSettingsStore(s => s.enabled);
   * Safe:      const { saveSettings } = useSoundStore();  // destructured
   * Safe:      useBadgeSettingsStore.getState()
   *
   * Destructured bare calls (`const { fn } = useStore()`) are allowed
   * because they extract individual values — primitives and function refs
   * are referentially stable in Zustand. The risk only materializes when
   * the whole store object is held as a single reference.
   */
  it('no components assign useXxxStore() to a single variable (non-destructured)', () => {
    // Match `const|let|var identifier = useXxxStore()` — non-destructured.
    // Does NOT match destructured: `const { a, b } = useXxxStore()`
    const bareAssignPattern =
      /(?:const|let|var)\s+(?!{)\w+\s*=\s*use(?!SyncExternalStore)\w+Store\(\s*\)/g;

    const violations: string[] = [];

    function scanDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          scanDir(fullPath);
        } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.includes('.test.')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          let match: RegExpExecArray | null;
          while ((match = bareAssignPattern.exec(content)) !== null) {
            const before = content.slice(0, match.index);
            const line = before.split('\n').length;
            const relPath = path.relative(rendererDir, fullPath);
            violations.push(`${relPath}:${line}: ${match[0]}`);
          }
        }
      }
    }

    scanDir(rendererDir);

    if (violations.length > 0) {
      throw new Error(
        'Non-destructured bare useXxxStore() assignment detected! ' +
        'Assigning the entire Zustand store to a single variable creates a reference ' +
        'that changes on every state update, breaking useMemo/useCallback dependencies ' +
        'and causing infinite re-render loops.\n\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n') +
        '\n\nFix: Use a selector to pick individual state fields: ' +
        '`const enabled = useXxxStore(s => s.enabled)`. If you need multiple fields, ' +
        'use multiple selector calls. If you need actions, use destructuring: ' +
        '`const { saveSettings } = useXxxStore()`.',
      );
    }
  });

  /**
   * Scan for inline `|| []` or `?? []` inside Zustand selector callbacks.
   * These create a new empty array on every render.
   *
   * Dangerous: useStore(s => s.items[id] || [])
   * Safe:      const EMPTY: T[] = []; useStore(s => s.items[id] ?? EMPTY)
   */
  it('no component selectors use inline || [] or ?? [] fallbacks', () => {
    const inlineFallbackPattern =
      /use\w+Store\(\s*(?:\([^)]*\)|[a-z_$]\w*)\s*=>[^)]*(?:\|\|\s*\[\s*\]|\?\?\s*\[\s*\])/g;

    const violations: string[] = [];

    function scanDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          scanDir(fullPath);
        } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.includes('.test.')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          let match: RegExpExecArray | null;
          while ((match = inlineFallbackPattern.exec(content)) !== null) {
            const before = content.slice(0, match.index);
            const line = before.split('\n').length;
            const relPath = path.relative(rendererDir, fullPath);
            violations.push(`${relPath}:${line}: ${match[0]}`);
          }
        }
      }
    }

    scanDir(rendererDir);

    if (violations.length > 0) {
      throw new Error(
        'Dangerous Zustand selector fallback pattern detected! ' +
        'Using `|| []` or `?? []` inside a selector creates a new array on every render.\n\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n') +
        '\n\nFix: Define a module-level constant (e.g. `const EMPTY: T[] = [];`) ' +
        'and use it as the fallback: `useStore(s => s.items[id] ?? EMPTY)`',
      );
    }
  });
});
