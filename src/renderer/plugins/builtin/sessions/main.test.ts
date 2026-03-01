import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate, deactivate, MainPanel, SidebarPanel } from './main';
import { sessionsState } from './state';
import { manifest } from './manifest';
import * as sessionsModule from './main';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { createMockContext, createMockAPI } from '../../testing';
import type { PluginAPI, PluginContext } from '../../../../shared/plugin-types';

// ── Built-in plugin validation ───────────────────────────────────────

describe('sessions plugin (built-in validation)', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: sessionsModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── activate() ───────────────────────────────────────────────────────

describe('sessions plugin activate()', () => {
  let ctx: PluginContext;
  let api: PluginAPI;

  beforeEach(() => {
    ctx = createMockContext({ pluginId: 'sessions' });
    api = createMockAPI();
  });

  it('does not throw', () => {
    expect(() => activate(ctx, api)).not.toThrow();
  });

  it('does not call any agent API methods during activation', () => {
    const listSpy = vi.fn().mockReturnValue([]);
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: listSpy,
      },
    });
    activate(ctx, api);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('works without project context', () => {
    const appCtx = createMockContext({ pluginId: 'sessions', scope: 'project', projectId: undefined, projectPath: undefined });
    expect(() => activate(appCtx, api)).not.toThrow();
  });
});

// ── deactivate() ─────────────────────────────────────────────────────

describe('sessions plugin deactivate()', () => {
  beforeEach(() => {
    sessionsState.reset();
  });

  it('does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('can be called multiple times', () => {
    deactivate();
    deactivate();
    deactivate();
  });

  it('resets sessionsState selectedAgent to null', () => {
    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    expect(sessionsState.selectedAgent).not.toBeNull();
    deactivate();
    expect(sessionsState.selectedAgent).toBeNull();
  });

  it('resets sessionsState selectedSessionId to null', () => {
    sessionsState.setSelectedSession('session-123');
    expect(sessionsState.selectedSessionId).toBe('session-123');
    deactivate();
    expect(sessionsState.selectedSessionId).toBeNull();
  });

  it('resets playback state', () => {
    sessionsState.setPlaybackPlaying(true);
    sessionsState.setPlaybackSpeed(5);
    sessionsState.setPlaybackIndex(10);
    deactivate();
    expect(sessionsState.playback).toEqual({ playing: false, speed: 1, currentEventIndex: 0 });
  });
});

// ── MainPanel (component contract) ───────────────────────────────────

describe('sessions plugin MainPanel', () => {
  it('is exported as a function', () => {
    expect(typeof MainPanel).toBe('function');
  });

  it('conforms to PluginModule.MainPanel shape (accepts { api })', () => {
    expect(MainPanel.length).toBeLessThanOrEqual(1);
  });
});

// ── SidebarPanel (component contract) ────────────────────────────────

describe('sessions plugin SidebarPanel', () => {
  it('is exported as a function', () => {
    expect(typeof SidebarPanel).toBe('function');
  });

  it('conforms to PluginModule.SidebarPanel shape (accepts { api })', () => {
    expect(SidebarPanel.length).toBeLessThanOrEqual(1);
  });
});

// ── Module exports ───────────────────────────────────────────────────

describe('sessions plugin module exports', () => {
  it('exports activate function', () => {
    expect(typeof sessionsModule.activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof sessionsModule.deactivate).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof sessionsModule.MainPanel).toBe('function');
  });

  it('exports SidebarPanel component', () => {
    expect(typeof (sessionsModule as any).SidebarPanel).toBe('function');
  });

  it('does not export HubPanel', () => {
    expect((sessionsModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel', () => {
    expect((sessionsModule as any).SettingsPanel).toBeUndefined();
  });
});

// ── Plugin lifecycle integration ─────────────────────────────────────

describe('sessions plugin lifecycle', () => {
  beforeEach(() => {
    sessionsState.reset();
  });

  it('activate then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'sessions' });
    const api = createMockAPI();
    activate(ctx, api);
    deactivate();
  });
});
