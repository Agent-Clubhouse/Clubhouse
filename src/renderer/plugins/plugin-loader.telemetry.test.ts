import { afterEach, describe, expect, it, vi } from 'vitest';
import { activatePlugin, classifyActivation } from './plugin-loader';
import { tel } from '../telemetry';
import { _resetRendererTelemetryForTests, _setStateForTests } from '../telemetry/facade';
import { usePluginStore } from './plugin-store';
import { canvasLoadOutcome } from './builtin/canvas/canvas-store';
import type { PluginManifest } from '../../shared/plugin-types';

function register(id: string, status: 'registered' | 'errored', error?: string) {
  const manifest = { id, name: id, version: '1.0.0', engine: { api: 0.9 }, scope: 'app' } as unknown as PluginManifest;
  usePluginStore.getState().registerPlugin(manifest, 'community', '/plugins/' + id, 'registered');
  if (status === 'errored') usePluginStore.getState().setPluginStatus(id, 'errored', error);
}

describe('plugin activation telemetry', () => {
  it('classifies failed activations from the stored error, never sending it', () => {
    register('a', 'errored', 'Failed to load module due to module-graph resolution: /Users/x/secret');
    register('b', 'errored', 'Plugin module at "/Users/x/main.js" did not export a valid module object');
    register('c', 'errored', 'Activation failed: activate() for "c" timed out after 20000ms');
    register('d', 'errored', 'Activation failed: TypeError: boom');
    expect(classifyActivation('a', 'a')).toEqual({ error: 'module_resolve_failed' });
    expect(classifyActivation('b', 'b')).toEqual({ error: 'invalid_export' });
    expect(classifyActivation('c', 'c')).toEqual({ error: 'activation_timeout' });
    expect(classifyActivation('d', 'd')).toEqual({ error: 'activate_threw' });
  });

  it('treats an activation that neither succeeded nor failed as skipped', () => {
    register('e', 'registered');
    expect(classifyActivation('e', 'e')).toEqual({ outcome: 'skipped' });
  });
});

describe('activation spans', () => {
  afterEach(() => _resetRendererTelemetryForTests());

  it('opens no span for activations that bail out before trying', async () => {
    _setStateForTests({ enabled: true, level: 'standard' });
    const flow = vi.spyOn(tel, 'flow');
    const manifest = { id: 'blocked', name: 'blocked', version: '1.0.0', engine: { api: 0.9 }, scope: 'project' } as unknown as PluginManifest;
    usePluginStore.getState().registerPlugin(manifest, 'community', '/plugins/blocked', 'registered');
    // A project-scoped plugin without a project is skipped by the loader.
    await activatePlugin('blocked');
    usePluginStore.getState().setPluginStatus('blocked', 'incompatible');
    await activatePlugin('blocked', 'proj_1', '/p');
    expect(flow).not.toHaveBeenCalled();
  });
});

describe('canvas load telemetry', () => {
  it('marks unreadable and failed loads as errors', () => {
    expect(canvasLoadOutcome('ok')).toBe('ok');
    expect(canvasLoadOutcome('new')).toBe('ok');
    expect(canvasLoadOutcome('recovered_from_backup')).toBe('ok');
    expect(canvasLoadOutcome('degraded')).toBe('ok');
    expect(canvasLoadOutcome('unreadable')).toEqual({ error: 'canvas_unreadable' });
    expect(canvasLoadOutcome('failed')).toEqual({ error: 'canvas_load_failed' });
  });
});
