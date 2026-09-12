import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasAPI, setCanvasQueryProvider } from './plugin-api-canvas';
import { _resetRegistryForTesting, getRegisteredWidgetType } from './canvas-widget-registry';
import type { CanvasWidgetDescriptor, PluginContext, PluginManifest } from '../../shared/plugin-types';
import React from 'react';

const ctx: PluginContext = {
  pluginId: 'canvas-plugin',
  pluginPath: '/tmp/canvas-plugin',
  projectId: 'project-1',
  projectPath: '/tmp/project',
  scope: 'project',
  subscriptions: [],
  settings: {},
};

const manifest: PluginManifest = {
  id: 'canvas-plugin',
  name: 'Canvas Plugin',
  version: '1.0.0',
  engine: { api: 0.8 },
  scope: 'project',
  permissions: ['canvas'],
  contributes: {
    canvasWidgets: [{ id: 'chart', label: 'Chart', icon: '+', metadataKeys: [] }],
  },
};

const descriptor: CanvasWidgetDescriptor = {
  id: 'chart',
  component: (() => React.createElement('div')) as CanvasWidgetDescriptor['component'],
};

describe('createCanvasAPI', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
    setCanvasQueryProvider(null);
    ctx.subscriptions.length = 0;
  });

  it('registers declared widget types and disposes them', () => {
    const api = createCanvasAPI(ctx, manifest);

    const disposable = api.registerWidgetType(descriptor);
    expect(getRegisteredWidgetType('plugin:canvas-plugin:chart')?.descriptor).toBe(descriptor);
    expect(ctx.subscriptions).toContain(disposable);

    disposable.dispose();
    expect(getRegisteredWidgetType('plugin:canvas-plugin:chart')).toBeUndefined();
  });

  it('rejects widget types that are not declared in the manifest', () => {
    const api = createCanvasAPI(ctx, manifest);

    expect(() => api.registerWidgetType({ ...descriptor, id: 'missing' })).toThrow(
      'not declared in contributes.canvasWidgets',
    );
  });

  it('delegates widget queries to the active provider', () => {
    const provider = vi.fn().mockReturnValue([{ id: 'widget-1', type: 'chart' }]);
    setCanvasQueryProvider(provider);
    const filter = { type: 'chart' };

    const result = createCanvasAPI(ctx, manifest).queryWidgets(filter);

    expect(provider).toHaveBeenCalledWith(filter);
    expect(result).toEqual([{ id: 'widget-1', type: 'chart' }]);
  });
});
