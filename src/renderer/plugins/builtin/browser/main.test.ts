import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate, deactivate, MainPanel, SidebarPanel } from './main';
import { browserState } from './state';
import { manifest } from './manifest';
import * as browserModule from './main';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { createMockContext, createMockAPI } from '../../testing';
import type { PluginAPI, PluginContext } from '../../../../shared/plugin-types';

// ── Built-in plugin validation ───────────────────────────────────────

describe('browser plugin (built-in validation)', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: browserModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── activate() ───────────────────────────────────────────────────────

describe('browser plugin activate()', () => {
  let ctx: PluginContext;
  let api: PluginAPI;
  let registerSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    browserState.reset();
    ctx = createMockContext({ pluginId: 'browser' });
    registerSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({ commands: { register: registerSpy, execute: vi.fn() } });
  });

  it('registers reload and devtools commands', () => {
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledWith('reload', expect.any(Function));
    expect(registerSpy).toHaveBeenCalledWith('devtools', expect.any(Function));
  });

  it('registers exactly two commands', () => {
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledTimes(2);
  });

  it('pushes three disposables to ctx.subscriptions (2 commands + canvas widget)', () => {
    activate(ctx, api);
    expect(ctx.subscriptions).toHaveLength(3);
    for (const sub of ctx.subscriptions) {
      expect(typeof sub.dispose).toBe('function');
    }
  });

  it('registers canvas widget type with id "webview"', () => {
    const canvasRegisterSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      canvas: { registerWidgetType: canvasRegisterSpy, queryWidgets: () => [] },
    });
    activate(ctx, api);
    expect(canvasRegisterSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'webview' }),
    );
  });

  it('canvas widget generateDisplayName extracts hostname from URL', () => {
    const canvasRegisterSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      canvas: { registerWidgetType: canvasRegisterSpy, queryWidgets: () => [] },
    });
    activate(ctx, api);
    const descriptor = canvasRegisterSpy.mock.calls[0][0];
    expect(descriptor.generateDisplayName({ url: 'https://example.com/path' })).toBe('example.com');
  });

  it('canvas widget generateDisplayName returns "Browser" for missing URL', () => {
    const canvasRegisterSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      canvas: { registerWidgetType: canvasRegisterSpy, queryWidgets: () => [] },
    });
    activate(ctx, api);
    const descriptor = canvasRegisterSpy.mock.calls[0][0];
    expect(descriptor.generateDisplayName({})).toBe('Browser');
  });

  it('canvas widget generateDisplayName returns "Browser" for invalid URL', () => {
    const canvasRegisterSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      canvas: { registerWidgetType: canvasRegisterSpy, queryWidgets: () => [] },
    });
    activate(ctx, api);
    const descriptor = canvasRegisterSpy.mock.calls[0][0];
    expect(descriptor.generateDisplayName({ url: 'not-a-url' })).toBe('Browser');
  });

  it('does not throw when called without project context', () => {
    const appCtx = createMockContext({ pluginId: 'browser', scope: 'dual', projectId: undefined, projectPath: undefined });
    expect(() => activate(appCtx, api)).not.toThrow();
  });
});

// ── deactivate() ─────────────────────────────────────────────────────

describe('browser plugin deactivate()', () => {
  beforeEach(() => {
    browserState.reset();
  });

  it('does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('returns void', () => {
    expect(deactivate()).toBeUndefined();
  });

  it('can be called multiple times', () => {
    deactivate();
    deactivate();
    deactivate();
  });

  it('resets browserState currentUrl', () => {
    browserState.setCurrentPage('https://example.com', 'Example');
    expect(browserState.currentUrl).not.toBe('');
    deactivate();
    expect(browserState.currentUrl).toBe('');
  });

  it('resets browserState history', () => {
    browserState.setCurrentPage('https://example.com', 'Example');
    expect(browserState.history).toHaveLength(1);
    deactivate();
    expect(browserState.history).toEqual([]);
  });

  it('clears all listeners', () => {
    const listener = vi.fn();
    browserState.subscribe(listener);
    deactivate();
    browserState.setCurrentPage('https://test.com', 'Test');
    expect(listener).not.toHaveBeenCalled();
  });

  it('clears all command handlers', () => {
    const handler = vi.fn();
    browserState.onCommand(handler);
    deactivate();
    browserState.dispatchCommand('reload');
    expect(handler).not.toHaveBeenCalled();
  });
});

// ── browserState (pub/sub) ──────────────────────────────────────────

describe('browserState', () => {
  beforeEach(() => {
    browserState.reset();
  });

  it('currentUrl starts empty', () => {
    expect(browserState.currentUrl).toBe('');
  });

  it('history starts empty', () => {
    expect(browserState.history).toEqual([]);
  });

  it('setCurrentPage updates URL and title and notifies', () => {
    const listener = vi.fn();
    browserState.subscribe(listener);
    browserState.setCurrentPage('https://example.com', 'Example');
    expect(browserState.currentUrl).toBe('https://example.com');
    expect(browserState.currentTitle).toBe('Example');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setCurrentPage adds to history', () => {
    browserState.setCurrentPage('https://example.com', 'Example');
    expect(browserState.history).toHaveLength(1);
    expect(browserState.history[0].url).toBe('https://example.com');
  });

  it('setCurrentPage deduplicates consecutive same-URL entries', () => {
    browserState.setCurrentPage('https://example.com', 'Example');
    browserState.setCurrentPage('https://example.com', 'Example Updated');
    expect(browserState.history).toHaveLength(1);
  });

  it('setCurrentPage adds different URLs', () => {
    browserState.setCurrentPage('https://example.com', 'Example');
    browserState.setCurrentPage('https://other.com', 'Other');
    expect(browserState.history).toHaveLength(2);
    expect(browserState.history[0].url).toBe('https://other.com');
    expect(browserState.history[1].url).toBe('https://example.com');
  });

  it('history capped at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      browserState.setCurrentPage(`https://example.com/${i}`, `Page ${i}`);
    }
    expect(browserState.history.length).toBeLessThanOrEqual(50);
  });

  it('subscribe returns unsubscribe function', () => {
    const listener = vi.fn();
    const unsub = browserState.subscribe(listener);
    browserState.setCurrentPage('https://test.com', 'Test');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    browserState.setCurrentPage('https://other.com', 'Other');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispatchCommand calls all registered handlers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    browserState.onCommand(h1);
    browserState.onCommand(h2);
    browserState.dispatchCommand('reload');
    expect(h1).toHaveBeenCalledWith('reload');
    expect(h2).toHaveBeenCalledWith('reload');
  });

  it('onCommand returns unsubscribe function', () => {
    const handler = vi.fn();
    const unsub = browserState.onCommand(handler);
    browserState.dispatchCommand('reload');
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
    browserState.dispatchCommand('reload');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reset clears everything', () => {
    const listener = vi.fn();
    const handler = vi.fn();
    browserState.subscribe(listener);
    browserState.onCommand(handler);
    browserState.setCurrentPage('https://test.com', 'Test');
    listener.mockClear();

    browserState.reset();
    expect(browserState.currentUrl).toBe('');
    expect(browserState.currentTitle).toBe('');
    expect(browserState.history).toEqual([]);

    browserState.setCurrentPage('https://new.com', 'New');
    expect(listener).not.toHaveBeenCalled();
    browserState.dispatchCommand('reload');
    expect(handler).not.toHaveBeenCalled();
  });

  it('double-unsubscribe is safe', () => {
    const listener = vi.fn();
    const unsub = browserState.subscribe(listener);
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ── MainPanel (component contract) ───────────────────────────────────

describe('browser plugin MainPanel', () => {
  it('is exported as a function', () => {
    expect(typeof MainPanel).toBe('function');
  });

  it('conforms to PluginModule.MainPanel shape (accepts { api })', () => {
    expect(MainPanel.length).toBeLessThanOrEqual(1);
  });
});

// ── SidebarPanel (component contract) ────────────────────────────────

describe('browser plugin SidebarPanel', () => {
  it('is exported as a function', () => {
    expect(typeof SidebarPanel).toBe('function');
  });

  it('conforms to PluginModule.SidebarPanel shape (accepts { api })', () => {
    expect(SidebarPanel.length).toBeLessThanOrEqual(1);
  });
});

// ── Module exports ───────────────────────────────────────────────────

describe('browser plugin module exports', () => {
  it('exports activate function', () => {
    expect(typeof browserModule.activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof browserModule.deactivate).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof browserModule.MainPanel).toBe('function');
  });

  it('exports SidebarPanel component', () => {
    expect(typeof (browserModule as any).SidebarPanel).toBe('function');
  });

  it('does not export HubPanel', () => {
    expect((browserModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel (uses declarative)', () => {
    expect((browserModule as any).SettingsPanel).toBeUndefined();
  });
});

// ── Plugin lifecycle integration ─────────────────────────────────────

describe('browser plugin lifecycle', () => {
  beforeEach(() => {
    browserState.reset();
  });

  it('activate then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'browser' });
    const api = createMockAPI();
    activate(ctx, api);
    deactivate();
  });

  it('subscriptions from activate are disposable', () => {
    const ctx = createMockContext({ pluginId: 'browser' });
    const disposeSpy = vi.fn();
    const api = createMockAPI({
      commands: { register: () => ({ dispose: disposeSpy }), execute: vi.fn() },
    });
    activate(ctx, api);
    expect(ctx.subscriptions).toHaveLength(3);
    ctx.subscriptions[0].dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
