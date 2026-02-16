import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activate, deactivate, MainPanel, SidebarPanel } from './main';
import { voiceState } from './state';
import { manifest } from './manifest';
import * as voiceChatModule from './main';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { createMockContext, createMockAPI } from '../../testing';
import type { PluginAPI, PluginContext } from '../../../../shared/plugin-types';

// ── Built-in plugin validation ───────────────────────────────────────

describe('voice-chat plugin (built-in validation)', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: voiceChatModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── activate() ───────────────────────────────────────────────────────

describe('voice-chat plugin activate()', () => {
  let ctx: PluginContext;
  let api: PluginAPI;

  beforeEach(() => {
    ctx = createMockContext({ pluginId: 'voice-chat' });
    api = createMockAPI();
  });

  it('does not throw', () => {
    expect(() => activate(ctx, api)).not.toThrow();
  });

  it('does not push subscriptions (no commands registered)', () => {
    activate(ctx, api);
    expect(ctx.subscriptions).toHaveLength(0);
  });

  it('does not call any voice API methods during activation', () => {
    const checkModelsSpy = vi.fn(async () => []);
    api = createMockAPI({
      voice: {
        ...api.voice,
        checkModels: checkModelsSpy,
      },
    });
    activate(ctx, api);
    expect(checkModelsSpy).not.toHaveBeenCalled();
  });

  it('works without project context', () => {
    const noProjectCtx = createMockContext({
      pluginId: 'voice-chat',
      projectId: undefined,
      projectPath: undefined,
    });
    expect(() => activate(noProjectCtx, api)).not.toThrow();
  });
});

// ── deactivate() ─────────────────────────────────────────────────────

describe('voice-chat plugin deactivate()', () => {
  beforeEach(() => {
    voiceState.reset();
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

  it('resets voiceState selectedAgent to null', () => {
    voiceState.setSelectedAgent({
      id: 'a1', name: 'test', kind: 'durable', status: 'sleeping',
      color: 'blue', projectId: 'p1',
    });
    expect(voiceState.selectedAgent).not.toBeNull();
    deactivate();
    expect(voiceState.selectedAgent).toBeNull();
  });

  it('resets voiceState transcript to empty', () => {
    voiceState.addTranscriptEntry({ role: 'user', text: 'hello', timestamp: 1 });
    expect(voiceState.transcript).toHaveLength(1);
    deactivate();
    expect(voiceState.transcript).toEqual([]);
  });

  it('resets voiceState status to idle', () => {
    voiceState.setStatus('speaking');
    deactivate();
    expect(voiceState.status).toBe('idle');
  });

  it('calls api.voice.endSession when session is active', () => {
    const endSessionSpy = vi.fn(async () => {});
    const ctx = createMockContext({ pluginId: 'voice-chat' });
    const api = createMockAPI({
      voice: {
        ...createMockAPI().voice,
        endSession: endSessionSpy,
      },
    });
    activate(ctx, api);
    voiceState.setSessionActive(true);
    deactivate();
    expect(endSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('does not call endSession when no session is active', () => {
    const endSessionSpy = vi.fn(async () => {});
    const ctx = createMockContext({ pluginId: 'voice-chat' });
    const api = createMockAPI({
      voice: {
        ...createMockAPI().voice,
        endSession: endSessionSpy,
      },
    });
    activate(ctx, api);
    voiceState.setSessionActive(false);
    deactivate();
    expect(endSessionSpy).not.toHaveBeenCalled();
  });
});

// ── voiceState (pub/sub) ─────────────────────────────────────────────

describe('voiceState', () => {
  beforeEach(() => {
    voiceState.reset();
  });

  it('selectedAgent starts null', () => {
    expect(voiceState.selectedAgent).toBeNull();
  });

  it('status starts idle', () => {
    expect(voiceState.status).toBe('idle');
  });

  it('transcript starts empty', () => {
    expect(voiceState.transcript).toEqual([]);
  });

  it('modelsReady starts false', () => {
    expect(voiceState.modelsReady).toBe(false);
  });

  it('sessionActive starts false', () => {
    expect(voiceState.sessionActive).toBe(false);
  });

  it('setSelectedAgent updates value and notifies listeners', () => {
    const listener = vi.fn();
    voiceState.subscribe(listener);
    const agent = { id: 'a1', name: 'test', kind: 'durable' as const, status: 'sleeping' as const, color: 'blue', projectId: 'p1' };
    voiceState.setSelectedAgent(agent);
    expect(voiceState.selectedAgent).toBe(agent);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setStatus updates value and notifies listeners', () => {
    const listener = vi.fn();
    voiceState.subscribe(listener);
    voiceState.setStatus('speaking');
    expect(voiceState.status).toBe('speaking');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('addTranscriptEntry appends and notifies', () => {
    const listener = vi.fn();
    voiceState.subscribe(listener);
    voiceState.addTranscriptEntry({ role: 'user', text: 'hello', timestamp: 1 });
    expect(voiceState.transcript).toHaveLength(1);
    expect(voiceState.transcript[0].text).toBe('hello');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('appendToLastAssistant appends text to last assistant entry', () => {
    voiceState.addTranscriptEntry({ role: 'assistant', text: 'Hello', timestamp: 1 });
    voiceState.appendToLastAssistant(' world');
    expect(voiceState.transcript[0].text).toBe('Hello world');
  });

  it('appendToLastAssistant does nothing if last entry is user', () => {
    voiceState.addTranscriptEntry({ role: 'user', text: 'hi', timestamp: 1 });
    voiceState.appendToLastAssistant(' world');
    expect(voiceState.transcript[0].text).toBe('hi');
  });

  it('appendToLastAssistant does nothing if transcript is empty', () => {
    voiceState.appendToLastAssistant('test');
    expect(voiceState.transcript).toEqual([]);
  });

  it('clearTranscript empties the transcript', () => {
    voiceState.addTranscriptEntry({ role: 'user', text: 'hi', timestamp: 1 });
    voiceState.clearTranscript();
    expect(voiceState.transcript).toEqual([]);
  });

  it('subscribe returns unsubscribe function that prevents further callbacks', () => {
    const listener = vi.fn();
    const unsub = voiceState.subscribe(listener);
    voiceState.setStatus('listening');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    voiceState.setStatus('idle');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reset clears all state and listeners', () => {
    const listener = vi.fn();
    voiceState.subscribe(listener);
    voiceState.setSelectedAgent({ id: 'a1', name: 'test', kind: 'durable', status: 'sleeping', color: 'blue', projectId: 'p1' });
    voiceState.setStatus('speaking');
    voiceState.addTranscriptEntry({ role: 'user', text: 'hi', timestamp: 1 });
    voiceState.setModelsReady(true);
    voiceState.setSessionActive(true);
    listener.mockClear();

    voiceState.reset();
    expect(voiceState.selectedAgent).toBeNull();
    expect(voiceState.status).toBe('idle');
    expect(voiceState.transcript).toEqual([]);
    expect(voiceState.modelsReady).toBe(false);
    expect(voiceState.sessionActive).toBe(false);

    // Listener was cleared, so further changes don't notify
    voiceState.setStatus('listening');
    expect(listener).not.toHaveBeenCalled();
  });

  it('multiple listeners all receive notifications', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    voiceState.subscribe(l1);
    voiceState.subscribe(l2);
    voiceState.setStatus('transcribing');
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('double-unsubscribe is safe (no-op)', () => {
    const listener = vi.fn();
    const unsub = voiceState.subscribe(listener);
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ── MainPanel (component contract) ───────────────────────────────────

describe('voice-chat plugin MainPanel', () => {
  it('is exported as a function', () => {
    expect(typeof MainPanel).toBe('function');
  });

  it('conforms to PluginModule.MainPanel shape (accepts { api })', () => {
    expect(MainPanel.length).toBeLessThanOrEqual(1);
  });
});

// ── SidebarPanel (component contract) ────────────────────────────────

describe('voice-chat plugin SidebarPanel', () => {
  it('is exported as a function', () => {
    expect(typeof SidebarPanel).toBe('function');
  });

  it('conforms to PluginModule.SidebarPanel shape (accepts { api })', () => {
    expect(SidebarPanel.length).toBeLessThanOrEqual(1);
  });
});

// ── Module exports ───────────────────────────────────────────────────

describe('voice-chat plugin module exports', () => {
  it('exports activate function', () => {
    expect(typeof voiceChatModule.activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof voiceChatModule.deactivate).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof voiceChatModule.MainPanel).toBe('function');
  });

  it('exports SidebarPanel component', () => {
    expect(typeof (voiceChatModule as any).SidebarPanel).toBe('function');
  });

  it('does not export HubPanel', () => {
    expect((voiceChatModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel', () => {
    expect((voiceChatModule as any).SettingsPanel).toBeUndefined();
  });
});

// ── Plugin API assumptions ───────────────────────────────────────────

describe('voice-chat plugin API assumptions', () => {
  let api: PluginAPI;

  beforeEach(() => {
    api = createMockAPI();
  });

  describe('voice.checkModels', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.voice.checkModels).toBe('function');
      expect(api.voice.checkModels()).toBeInstanceOf(Promise);
    });

    it('resolves to an array', async () => {
      const result = await api.voice.checkModels();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('voice.downloadModels', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.voice.downloadModels).toBe('function');
      expect(api.voice.downloadModels()).toBeInstanceOf(Promise);
    });
  });

  describe('voice.transcribe', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.voice.transcribe).toBe('function');
      expect(api.voice.transcribe(new ArrayBuffer(0))).toBeInstanceOf(Promise);
    });

    it('resolves to a string', async () => {
      const result = await api.voice.transcribe(new ArrayBuffer(0));
      expect(typeof result).toBe('string');
    });
  });

  describe('voice.startSession', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.voice.startSession).toBe('function');
      expect(api.voice.startSession('agent-1', '/cwd')).toBeInstanceOf(Promise);
    });

    it('resolves to object with sessionId', async () => {
      const result = await api.voice.startSession('agent-1', '/cwd');
      expect(result).toHaveProperty('sessionId');
    });
  });

  describe('voice.sendTurn', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.voice.sendTurn).toBe('function');
      expect(api.voice.sendTurn('hello')).toBeInstanceOf(Promise);
    });
  });

  describe('voice.onTurnChunk', () => {
    it('exists and returns a Disposable', () => {
      expect(typeof api.voice.onTurnChunk).toBe('function');
      const d = api.voice.onTurnChunk(() => {});
      expect(typeof d.dispose).toBe('function');
    });

    it('dispose does not throw', () => {
      const d = api.voice.onTurnChunk(() => {});
      expect(() => d.dispose()).not.toThrow();
    });
  });

  describe('voice.onTurnComplete', () => {
    it('exists and returns a Disposable', () => {
      expect(typeof api.voice.onTurnComplete).toBe('function');
      const d = api.voice.onTurnComplete(() => {});
      expect(typeof d.dispose).toBe('function');
    });
  });

  describe('voice.onDownloadProgress', () => {
    it('exists and returns a Disposable', () => {
      expect(typeof api.voice.onDownloadProgress).toBe('function');
      const d = api.voice.onDownloadProgress(() => {});
      expect(typeof d.dispose).toBe('function');
    });
  });

  describe('voice.endSession', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.voice.endSession).toBe('function');
      expect(api.voice.endSession()).toBeInstanceOf(Promise);
    });
  });

  describe('agents.list()', () => {
    it('exists and returns an array', () => {
      expect(typeof api.agents.list).toBe('function');
      expect(Array.isArray(api.agents.list())).toBe(true);
    });
  });

  describe('agents.kill()', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.agents.kill).toBe('function');
      expect(api.agents.kill('a1')).toBeInstanceOf(Promise);
    });
  });

  describe('agents.onAnyChange()', () => {
    it('exists and returns a Disposable', () => {
      expect(typeof api.agents.onAnyChange).toBe('function');
      const d = api.agents.onAnyChange(() => {});
      expect(typeof d.dispose).toBe('function');
    });
  });

  describe('ui.showConfirm()', () => {
    it('exists and returns a promise', () => {
      expect(typeof api.ui.showConfirm).toBe('function');
      expect(api.ui.showConfirm('test')).toBeInstanceOf(Promise);
    });
  });
});

// ── Plugin lifecycle integration ─────────────────────────────────────

describe('voice-chat plugin lifecycle', () => {
  beforeEach(() => {
    voiceState.reset();
  });

  it('activate then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'voice-chat' });
    const api = createMockAPI();
    activate(ctx, api);
    deactivate();
  });

  it('activate twice then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'voice-chat' });
    const api = createMockAPI();
    activate(ctx, api);
    activate(ctx, api);
    deactivate();
  });

  it('deactivate without activate does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
