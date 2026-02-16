import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { activate, deactivate, MainPanel, SidebarPanel } from './main';
import { manifest } from './manifest';
import * as issuesModule from './main';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { createMockContext, createMockAPI } from '../../testing';
import { issueState } from './state';
import type { PluginAPI, PluginContext } from '../../../../shared/plugin-types';

// ── Built-in plugin validation ──────────────────────────────────────────

describe('issues plugin (built-in validation)', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: issuesModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── activate() ──────────────────────────────────────────────────────────

describe('issues plugin activate()', () => {
  let ctx: PluginContext;
  let api: PluginAPI;
  let registerSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ctx = createMockContext({ pluginId: 'issues' });
    registerSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
    });
  });

  afterEach(() => {
    deactivate();
  });

  it('registers refresh and create commands', () => {
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledWith('refresh', expect.any(Function));
    expect(registerSpy).toHaveBeenCalledWith('create', expect.any(Function));
  });

  it('pushes exactly 2 disposables to ctx.subscriptions', () => {
    activate(ctx, api);
    expect(ctx.subscriptions).toHaveLength(2);
    for (const sub of ctx.subscriptions) {
      expect(typeof sub.dispose).toBe('function');
    }
  });

  it('refresh command resets issue state', () => {
    activate(ctx, api);
    // Add some state
    issueState.setIssues([{ number: 1, title: 'Test', state: 'OPEN', url: '', createdAt: '', updatedAt: '', author: { login: 'a' }, labels: [] }]);
    issueState.page = 3;

    // Get the refresh handler and call it
    const refreshCall = registerSpy.mock.calls.find((c: any[]) => c[0] === 'refresh');
    expect(refreshCall).toBeDefined();
    refreshCall![1]();

    expect(issueState.page).toBe(1);
    expect(issueState.issues).toEqual([]);
  });

  it('create command prompts for title and body', async () => {
    const showInputSpy = vi.fn()
      .mockResolvedValueOnce('Bug title')
      .mockResolvedValueOnce('Bug body');
    const showNoticeSpy = vi.fn();
    const createIssueSpy = vi.fn().mockResolvedValue({ ok: true, url: 'https://github.com/repo/issues/1' });

    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      ui: { ...createMockAPI().ui, showInput: showInputSpy, showNotice: showNoticeSpy },
      github: { ...createMockAPI().github, createIssue: createIssueSpy },
    });

    activate(ctx, api);

    const createCall = registerSpy.mock.calls.find((c: any[]) => c[0] === 'create');
    await createCall![1]();

    expect(showInputSpy).toHaveBeenCalledTimes(2);
    expect(showInputSpy).toHaveBeenCalledWith('Issue title');
    expect(showInputSpy).toHaveBeenCalledWith('Issue body (optional)', '');
    expect(createIssueSpy).toHaveBeenCalledWith('Bug title', 'Bug body');
    expect(showNoticeSpy).toHaveBeenCalledWith('Issue created: https://github.com/repo/issues/1');
  });

  it('create command shows error on failure', async () => {
    const showInputSpy = vi.fn()
      .mockResolvedValueOnce('Title')
      .mockResolvedValueOnce('');
    const showErrorSpy = vi.fn();
    const createIssueSpy = vi.fn().mockResolvedValue({ ok: false, message: 'Auth failed' });

    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      ui: { ...createMockAPI().ui, showInput: showInputSpy, showError: showErrorSpy },
      github: { ...createMockAPI().github, createIssue: createIssueSpy },
    });

    activate(ctx, api);
    const createCall = registerSpy.mock.calls.find((c: any[]) => c[0] === 'create');
    await createCall![1]();

    expect(showErrorSpy).toHaveBeenCalledWith('Auth failed');
  });

  it('create command does nothing when user cancels title prompt', async () => {
    const showInputSpy = vi.fn().mockResolvedValueOnce(null);
    const createIssueSpy = vi.fn();

    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      ui: { ...createMockAPI().ui, showInput: showInputSpy },
      github: { ...createMockAPI().github, createIssue: createIssueSpy },
    });

    activate(ctx, api);
    const createCall = registerSpy.mock.calls.find((c: any[]) => c[0] === 'create');
    await createCall![1]();

    expect(createIssueSpy).not.toHaveBeenCalled();
  });
});

// ── deactivate() ────────────────────────────────────────────────────────

describe('issues plugin deactivate()', () => {
  it('resets issue state', () => {
    issueState.setIssues([{ number: 1, title: 'Test', state: 'OPEN', url: '', createdAt: '', updatedAt: '', author: { login: 'a' }, labels: [] }]);
    issueState.setSelectedIssue(1);

    deactivate();

    expect(issueState.issues).toEqual([]);
    expect(issueState.selectedIssueNumber).toBeNull();
  });

  it('does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('can be called multiple times', () => {
    deactivate();
    deactivate();
    deactivate();
  });
});

// ── Panel exports ───────────────────────────────────────────────────────

describe('issues plugin SidebarPanel', () => {
  it('is exported as a function', () => {
    expect(typeof SidebarPanel).toBe('function');
  });

  it('conforms to PluginModule.SidebarPanel shape (accepts { api })', () => {
    expect(SidebarPanel.length).toBeLessThanOrEqual(1);
  });
});

describe('issues plugin MainPanel', () => {
  it('is exported as a function', () => {
    expect(typeof MainPanel).toBe('function');
  });

  it('conforms to PluginModule.MainPanel shape (accepts { api })', () => {
    expect(MainPanel.length).toBeLessThanOrEqual(1);
  });
});

// ── Module exports ──────────────────────────────────────────────────────

describe('issues plugin module exports', () => {
  it('exports activate function', () => {
    expect(typeof issuesModule.activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof issuesModule.deactivate).toBe('function');
  });

  it('exports SidebarPanel component', () => {
    expect(typeof issuesModule.SidebarPanel).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof issuesModule.MainPanel).toBe('function');
  });

  it('does not export HubPanel', () => {
    expect((issuesModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel', () => {
    expect((issuesModule as any).SettingsPanel).toBeUndefined();
  });
});

// ── API assumptions ─────────────────────────────────────────────────────

describe('issues plugin API assumptions', () => {
  let api: PluginAPI;

  beforeEach(() => {
    api = createMockAPI();
  });

  describe('github.listIssues', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.github.listIssues).toBe('function');
      expect(api.github.listIssues()).toBeInstanceOf(Promise);
    });

    it('resolves to { issues: [], hasMore: false } by default', async () => {
      const result = await api.github.listIssues();
      expect(result.issues).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('accepts optional page/perPage/state options', async () => {
      await expect(api.github.listIssues({ page: 1, perPage: 30, state: 'open' })).resolves.toBeDefined();
    });
  });

  describe('github.viewIssue', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.github.viewIssue).toBe('function');
      expect(api.github.viewIssue(1)).toBeInstanceOf(Promise);
    });

    it('resolves to null by default (no issue found)', async () => {
      const result = await api.github.viewIssue(42);
      expect(result).toBeNull();
    });
  });

  describe('github.createIssue', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.github.createIssue).toBe('function');
      expect(api.github.createIssue('title', 'body')).toBeInstanceOf(Promise);
    });

    it('resolves to { ok: true } by default', async () => {
      const result = await api.github.createIssue('title', 'body');
      expect(result.ok).toBe(true);
    });
  });

  describe('github.getRepoUrl', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.github.getRepoUrl).toBe('function');
      expect(api.github.getRepoUrl()).toBeInstanceOf(Promise);
    });

    it('resolves to a string', async () => {
      const result = await api.github.getRepoUrl();
      expect(typeof result).toBe('string');
    });
  });

  describe('ui.showInput', () => {
    it('exists and returns a promise', () => {
      expect(api.ui.showInput('prompt')).toBeInstanceOf(Promise);
    });

    it('resolves to null by default (user cancelled)', async () => {
      const result = await api.ui.showInput('prompt');
      expect(result).toBeNull();
    });
  });

  describe('ui.openExternalUrl', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.ui.openExternalUrl).toBe('function');
      expect(api.ui.openExternalUrl('https://example.com')).toBeInstanceOf(Promise);
    });

    it('resolves to void', async () => {
      const result = await api.ui.openExternalUrl('https://example.com');
      expect(result).toBeUndefined();
    });
  });

  describe('agents.runQuick', () => {
    it('exists and returns a promise resolving to string', async () => {
      const result = await api.agents.runQuick('mission');
      expect(typeof result).toBe('string');
    });
  });

  describe('agents.list', () => {
    it('exists and returns an array', () => {
      expect(Array.isArray(api.agents.list())).toBe(true);
    });
  });

  describe('agents.kill', () => {
    it('exists and returns a promise', () => {
      expect(api.agents.kill('id')).toBeInstanceOf(Promise);
    });
  });

  describe('agents.resume', () => {
    it('exists and returns a promise', () => {
      expect(api.agents.resume('id')).toBeInstanceOf(Promise);
    });
  });

  describe('ui.showConfirm', () => {
    it('plugin uses it for agent restart warning', async () => {
      const result = await api.ui.showConfirm('This agent is running. Restarting will interrupt its work. Continue?');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('commands.register', () => {
    it('returns a Disposable', () => {
      const d = api.commands.register('refresh', () => {});
      expect(typeof d.dispose).toBe('function');
    });
  });
});

// ── Manifest ────────────────────────────────────────────────────────────

describe('issues plugin manifest', () => {
  it('has id "issues"', () => {
    expect(manifest.id).toBe('issues');
  });

  it('has scope "project"', () => {
    expect(manifest.scope).toBe('project');
  });

  it('has sidebar-content layout', () => {
    expect(manifest.contributes?.tab?.layout).toBe('sidebar-content');
  });

  it('declares refresh and create commands', () => {
    const commands = manifest.contributes?.commands ?? [];
    const ids = commands.map((c) => c.id);
    expect(ids).toContain('refresh');
    expect(ids).toContain('create');
  });

  it('has help topics', () => {
    const topics = manifest.contributes?.help?.topics ?? [];
    expect(topics.length).toBeGreaterThan(0);
    expect(topics[0].id).toBe('github-issues');
  });

  it('has an icon SVG', () => {
    expect(manifest.contributes?.tab?.icon).toContain('<svg');
  });
});

// ── issueState ──────────────────────────────────────────────────────────

describe('issueState', () => {
  afterEach(() => {
    issueState.reset();
  });

  it('setSelectedIssue notifies listeners', () => {
    const listener = vi.fn();
    issueState.subscribe(listener);

    issueState.setSelectedIssue(42);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(issueState.selectedIssueNumber).toBe(42);
  });

  it('setIssues replaces the list', () => {
    const items = [{ number: 1, title: 'A', state: 'OPEN', url: '', createdAt: '', updatedAt: '', author: { login: 'a' }, labels: [] }];
    issueState.setIssues(items);
    expect(issueState.issues).toEqual(items);
  });

  it('appendIssues adds to existing list', () => {
    const item1 = { number: 1, title: 'A', state: 'OPEN', url: '', createdAt: '', updatedAt: '', author: { login: 'a' }, labels: [] };
    const item2 = { number: 2, title: 'B', state: 'OPEN', url: '', createdAt: '', updatedAt: '', author: { login: 'b' }, labels: [] };
    issueState.setIssues([item1]);
    issueState.appendIssues([item2]);
    expect(issueState.issues).toHaveLength(2);
    expect(issueState.issues[1].number).toBe(2);
  });

  it('setLoading notifies listeners', () => {
    const listener = vi.fn();
    issueState.subscribe(listener);

    issueState.setLoading(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(issueState.loading).toBe(true);
  });

  it('subscribe returns an unsubscribe function', () => {
    const listener = vi.fn();
    const unsub = issueState.subscribe(listener);

    issueState.setSelectedIssue(1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    issueState.setSelectedIssue(2);
    expect(listener).toHaveBeenCalledTimes(1); // still 1, not called again
  });

  it('reset clears all state and listeners', () => {
    const listener = vi.fn();
    issueState.subscribe(listener);
    issueState.setIssues([{ number: 1, title: 'A', state: 'OPEN', url: '', createdAt: '', updatedAt: '', author: { login: 'a' }, labels: [] }]);
    issueState.setSelectedIssue(1);
    issueState.page = 5;
    issueState.hasMore = true;
    issueState.loading = true;

    issueState.reset();

    expect(issueState.issues).toEqual([]);
    expect(issueState.selectedIssueNumber).toBeNull();
    expect(issueState.page).toBe(1);
    expect(issueState.hasMore).toBe(false);
    expect(issueState.loading).toBe(false);

    // Listener was cleared, so notify should not call it
    listener.mockClear();
    issueState.notify();
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── Plugin lifecycle ────────────────────────────────────────────────────

describe('issues plugin lifecycle', () => {
  it('activate then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'issues' });
    const api = createMockAPI();
    activate(ctx, api);
    deactivate();
  });

  it('subscriptions from activate are disposable', () => {
    const ctx = createMockContext({ pluginId: 'issues' });
    const disposeSpy = vi.fn();
    const api = createMockAPI({
      commands: { register: () => ({ dispose: disposeSpy }), execute: vi.fn() },
    });
    activate(ctx, api);
    for (const sub of ctx.subscriptions) {
      sub.dispose();
    }
    expect(disposeSpy).toHaveBeenCalledTimes(2); // refresh + create
  });

  it('works without project context', () => {
    const ctx = createMockContext({ pluginId: 'issues', projectId: undefined, projectPath: undefined });
    const api = createMockAPI();
    expect(() => activate(ctx, api)).not.toThrow();
    expect(ctx.subscriptions).toHaveLength(2);
    deactivate();
  });
});
