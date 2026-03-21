/**
 * Built-in Canvas Widget Registration Tests
 *
 * These tests ensure that all built-in plugins which declare canvas widgets
 * are always discoverable and registered — preventing regressions where
 * widgets (terminal, file viewer, git status, etc.) silently disappear from
 * the canvas context menu or render as "not available".
 *
 * Root cause this guards against: project-scoped plugins (terminal, files,
 * git) only activate during handleProjectSwitch(), which runs asynchronously
 * after render. Without pre-registration, their widgets are invisible to the
 * canvas until that async activation completes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerCanvasWidgetType,
  getRegisteredWidgetTypes,
  getRegisteredWidgetType,
  onRegistryChange,
  preRegisterFromManifest,
  isWidgetPending,
  _resetRegistryForTesting,
} from './canvas-widget-registry';
import { getBuiltinPlugins, getDefaultEnabledIds } from './builtin';
import { getBuiltinProjectPluginIds } from './plugin-loader';
import { createMockContext, createMockAPI } from './testing';
import type { PluginCanvasWidgetDeclaration, CanvasWidgetDescriptor } from '../../shared/plugin-types';
import React from 'react';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeDeclaration(id: string, label = 'Test Widget'): PluginCanvasWidgetDeclaration {
  return { id, label, icon: '<svg/>' };
}

function makeDescriptor(id: string): CanvasWidgetDescriptor {
  return {
    id,
    component: (() => React.createElement('div')) as any,
  };
}

// ── Built-in plugin manifest canvas widget declarations ─────────────────

describe('built-in plugin canvas widget declarations', () => {
  /**
   * Snapshot of the expected canvas widget declarations for each built-in
   * plugin. If a plugin's canvasWidgets are accidentally removed or renamed,
   * this test will fail — catching the regression before it ships.
   */
  const EXPECTED_CANVAS_WIDGETS: Record<string, string[]> = {
    terminal: ['shell'],
    files: ['file-viewer'],
    git: ['git-status'],
    browser: ['webview'],
    'group-project': ['group-project'],
  };

  const allPlugins = getBuiltinPlugins({ canvas: true });

  for (const [pluginId, expectedWidgetIds] of Object.entries(EXPECTED_CANVAS_WIDGETS)) {
    describe(`${pluginId} plugin`, () => {
      const plugin = allPlugins.find((p) => p.manifest.id === pluginId);

      it('exists in the built-in plugin list', () => {
        expect(plugin).toBeDefined();
      });

      it('declares canvasWidgets in its manifest', () => {
        expect(plugin!.manifest.contributes?.canvasWidgets).toBeDefined();
        expect(plugin!.manifest.contributes!.canvasWidgets!.length).toBeGreaterThan(0);
      });

      for (const widgetId of expectedWidgetIds) {
        it(`declares widget "${widgetId}"`, () => {
          const widgets = plugin!.manifest.contributes!.canvasWidgets!;
          const widget = widgets.find((w) => w.id === widgetId);
          expect(widget, `Widget "${widgetId}" must be declared in ${pluginId} manifest`).toBeDefined();
          expect(widget!.label).toBeTruthy();
        });
      }

      it('has no undocumented widgets (update EXPECTED_CANVAS_WIDGETS if adding new ones)', () => {
        const widgets = plugin!.manifest.contributes!.canvasWidgets!;
        const actualIds = widgets.map((w) => w.id);
        expect(actualIds).toEqual(expectedWidgetIds);
      });
    });
  }

  it('all plugins with canvasWidgets are tracked in EXPECTED_CANVAS_WIDGETS', () => {
    const pluginsWithWidgets = allPlugins.filter(
      (p) => p.manifest.contributes?.canvasWidgets && p.manifest.contributes.canvasWidgets.length > 0,
    );
    const trackedIds = new Set(Object.keys(EXPECTED_CANVAS_WIDGETS));
    for (const p of pluginsWithWidgets) {
      expect(
        trackedIds.has(p.manifest.id),
        `Plugin "${p.manifest.id}" declares canvasWidgets but is not tracked in EXPECTED_CANVAS_WIDGETS — add it!`,
      ).toBe(true);
    }
  });
});

// ── getBuiltinProjectPluginIds ──────────────────────────────────────────

describe('getBuiltinProjectPluginIds', () => {
  it('includes terminal, files, and git (project-scoped plugins)', () => {
    const ids = getBuiltinProjectPluginIds();
    expect(ids).toContain('terminal');
    expect(ids).toContain('files');
    expect(ids).toContain('git');
  });

  it('includes browser (dual-scoped, also activated per project)', () => {
    const ids = getBuiltinProjectPluginIds();
    expect(ids).toContain('browser');
  });

  it('includes group-project when canvas experimental flag is set', () => {
    const ids = getBuiltinProjectPluginIds({ canvas: true });
    expect(ids).toContain('group-project');
  });

  it('includes hub (dual-scoped, part of defaults)', () => {
    const ids = getBuiltinProjectPluginIds();
    expect(ids).toContain('hub');
  });

  it('includes canvas when experimental flag is set', () => {
    const ids = getBuiltinProjectPluginIds({ canvas: true });
    expect(ids).toContain('canvas');
  });

  it('all project-scoped plugins with canvas widgets are in the returned list', () => {
    const allPlugins = getBuiltinPlugins({ canvas: true });
    const projectIds = getBuiltinProjectPluginIds({ canvas: true });
    const defaults = getDefaultEnabledIds({ canvas: true });

    const pluginsWithWidgets = allPlugins.filter(
      (p) =>
        p.manifest.contributes?.canvasWidgets &&
        p.manifest.contributes.canvasWidgets.length > 0 &&
        (p.manifest.scope === 'project' || p.manifest.scope === 'dual') &&
        defaults.has(p.manifest.id),
    );

    for (const p of pluginsWithWidgets) {
      expect(
        projectIds,
        `Plugin "${p.manifest.id}" has canvas widgets and scope ${p.manifest.scope} but is not in getBuiltinProjectPluginIds()`,
      ).toContain(p.manifest.id);
    }
  });
});

// ── Pre-registration from manifests ─────────────────────────────────────

describe('preRegisterFromManifest', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
  });

  it('creates a registry entry from a manifest declaration', () => {
    preRegisterFromManifest('terminal', makeDeclaration('shell', 'Terminal'));
    const entry = getRegisteredWidgetType('plugin:terminal:shell');
    expect(entry).toBeDefined();
    expect(entry!.pluginId).toBe('terminal');
    expect(entry!.declaration.label).toBe('Terminal');
  });

  it('marks the entry as pending', () => {
    preRegisterFromManifest('terminal', makeDeclaration('shell'));
    expect(isWidgetPending('plugin:terminal:shell')).toBe(true);
  });

  it('makes the widget appear in getRegisteredWidgetTypes()', () => {
    preRegisterFromManifest('terminal', makeDeclaration('shell', 'Terminal'));
    preRegisterFromManifest('files', makeDeclaration('file-viewer', 'File Viewer'));
    const types = getRegisteredWidgetTypes();
    expect(types).toHaveLength(2);
    expect(types.map((t) => t.qualifiedType)).toEqual(
      expect.arrayContaining(['plugin:terminal:shell', 'plugin:files:file-viewer']),
    );
  });

  it('does not overwrite an already-registered (real) widget', () => {
    const realDesc = makeDescriptor('shell');
    registerCanvasWidgetType('terminal', makeDeclaration('shell', 'Terminal'), realDesc);
    preRegisterFromManifest('terminal', makeDeclaration('shell', 'Terminal STALE'));

    const entry = getRegisteredWidgetType('plugin:terminal:shell')!;
    expect(entry.descriptor).toBe(realDesc);
    expect(entry.declaration.label).toBe('Terminal'); // not overwritten
  });

  it('is overwritten when the real plugin registers its widget', () => {
    preRegisterFromManifest('terminal', makeDeclaration('shell', 'Terminal'));
    expect(isWidgetPending('plugin:terminal:shell')).toBe(true);

    const realDesc = makeDescriptor('shell');
    registerCanvasWidgetType('terminal', makeDeclaration('shell', 'Terminal'), realDesc);

    expect(isWidgetPending('plugin:terminal:shell')).toBe(false);
    const entry = getRegisteredWidgetType('plugin:terminal:shell')!;
    expect(entry.descriptor).toBe(realDesc);
  });

  it('notifies registry listeners when pre-registering', () => {
    const listener = vi.fn();
    onRegistryChange(listener);

    preRegisterFromManifest('terminal', makeDeclaration('shell'));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── isWidgetPending ─────────────────────────────────────────────────────

describe('isWidgetPending', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
  });

  it('returns false for unregistered types', () => {
    expect(isWidgetPending('plugin:unknown:thing')).toBe(false);
  });

  it('returns true for pre-registered (pending) types', () => {
    preRegisterFromManifest('my-plugin', makeDeclaration('chart'));
    expect(isWidgetPending('plugin:my-plugin:chart')).toBe(true);
  });

  it('returns false for fully-registered (real) types', () => {
    registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
    expect(isWidgetPending('plugin:my-plugin:chart')).toBe(false);
  });

  it('transitions from true to false when real registration replaces pre-registration', () => {
    preRegisterFromManifest('my-plugin', makeDeclaration('chart'));
    expect(isWidgetPending('plugin:my-plugin:chart')).toBe(true);

    registerCanvasWidgetType('my-plugin', makeDeclaration('chart'), makeDescriptor('chart'));
    expect(isWidgetPending('plugin:my-plugin:chart')).toBe(false);
  });
});

// ── End-to-end: all built-in canvas widgets are pre-registerable ────────

describe('all built-in plugins with canvas widgets can be pre-registered', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
  });

  it('pre-registering all built-in canvas widgets populates the registry', () => {
    const allPlugins = getBuiltinPlugins({ canvas: true });

    for (const { manifest } of allPlugins) {
      if (manifest.contributes?.canvasWidgets) {
        for (const widgetDecl of manifest.contributes.canvasWidgets) {
          preRegisterFromManifest(manifest.id, widgetDecl);
        }
      }
    }

    const registered = getRegisteredWidgetTypes();
    // All widget-providing plugins should have entries
    expect(registered.length).toBeGreaterThanOrEqual(5); // terminal, files, git, browser, group-project

    // Verify specific expected widgets
    expect(getRegisteredWidgetType('plugin:terminal:shell')).toBeDefined();
    expect(getRegisteredWidgetType('plugin:files:file-viewer')).toBeDefined();
    expect(getRegisteredWidgetType('plugin:git:git-status')).toBeDefined();
    expect(getRegisteredWidgetType('plugin:browser:webview')).toBeDefined();
    expect(getRegisteredWidgetType('plugin:group-project:group-project')).toBeDefined();

    // All should be pending
    for (const entry of registered) {
      expect(isWidgetPending(entry.qualifiedType)).toBe(true);
    }
  });

  it('pre-registered widgets have correct labels from manifests', () => {
    const allPlugins = getBuiltinPlugins({ canvas: true });
    for (const { manifest } of allPlugins) {
      if (manifest.contributes?.canvasWidgets) {
        for (const widgetDecl of manifest.contributes.canvasWidgets) {
          preRegisterFromManifest(manifest.id, widgetDecl);
        }
      }
    }

    expect(getRegisteredWidgetType('plugin:terminal:shell')!.declaration.label).toBe('Terminal');
    expect(getRegisteredWidgetType('plugin:files:file-viewer')!.declaration.label).toBe('File Viewer');
    expect(getRegisteredWidgetType('plugin:git:git-status')!.declaration.label).toBe('Git Status');
    expect(getRegisteredWidgetType('plugin:browser:webview')!.declaration.label).toBe('Browser');
    expect(getRegisteredWidgetType('plugin:group-project:group-project')!.declaration.label).toBe('Group Project');
  });
});

// ── Built-in plugin activate() registers canvas widgets ─────────────────

describe('built-in plugin activate() canvas widget registration', () => {
  const allPlugins = getBuiltinPlugins({ canvas: true });
  const pluginsWithWidgets = allPlugins.filter(
    (p) => p.manifest.contributes?.canvasWidgets && p.manifest.contributes.canvasWidgets.length > 0,
  );

  for (const { manifest, module: mod } of pluginsWithWidgets) {
    // Skip plugins that don't have an activate function (pack-only)
    if (typeof mod.activate !== 'function') continue;

    describe(`${manifest.id} plugin activate()`, () => {
      it('calls api.canvas.registerWidgetType for each declared canvas widget', () => {
        const registerWidgetTypeSpy = vi.fn(() => ({ dispose: vi.fn() }));
        const ctx = createMockContext({ pluginId: manifest.id });
        const api = createMockAPI({
          canvas: {
            registerWidgetType: registerWidgetTypeSpy,
            queryWidgets: () => [],
          },
        });

        mod.activate!(ctx, api);

        const declaredWidgetIds = manifest.contributes!.canvasWidgets!.map((w) => w.id);
        for (const widgetId of declaredWidgetIds) {
          expect(
            registerWidgetTypeSpy.mock.calls.some(
              (call: any[]) => call[0]?.id === widgetId,
            ),
            `activate() should register widget "${widgetId}" for plugin "${manifest.id}"`,
          ).toBe(true);
        }
      });

      it('provides a React component for each registered widget', () => {
        const registeredDescriptors: any[] = [];
        const registerWidgetTypeSpy = vi.fn((desc: any) => {
          registeredDescriptors.push(desc);
          return { dispose: vi.fn() };
        });
        const ctx = createMockContext({ pluginId: manifest.id });
        const api = createMockAPI({
          canvas: {
            registerWidgetType: registerWidgetTypeSpy,
            queryWidgets: () => [],
          },
        });

        mod.activate!(ctx, api);

        for (const desc of registeredDescriptors) {
          expect(
            typeof desc.component === 'function',
            `Widget "${desc.id}" in plugin "${manifest.id}" must provide a component function`,
          ).toBe(true);
        }
      });
    });
  }
});
