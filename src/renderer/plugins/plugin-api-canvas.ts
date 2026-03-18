// ── Canvas API implementation ──────────────────────────────────────────
// Provides the runtime CanvasAPI for plugins that declare 'canvas' permission
// and contributes.canvasWidgets in their manifest.

import type {
  PluginContext,
  PluginManifest,
  CanvasAPI,
  CanvasWidgetDescriptor,
  CanvasWidgetFilter,
  CanvasWidgetHandle,
  Disposable,
} from '../../shared/plugin-types';
import {
  registerCanvasWidgetType,
} from './canvas-widget-registry';

export function createCanvasAPI(ctx: PluginContext, manifest?: PluginManifest): CanvasAPI {
  const declaredWidgets = manifest?.contributes?.canvasWidgets ?? [];

  return {
    registerWidgetType(descriptor: CanvasWidgetDescriptor): Disposable {
      // Ensure the widget type was declared in the manifest
      const declaration = declaredWidgets.find((d) => d.id === descriptor.id);
      if (!declaration) {
        throw new Error(
          `[${ctx.pluginId}] Cannot register canvas widget type "${descriptor.id}": ` +
          `not declared in contributes.canvasWidgets. Declared types: ${declaredWidgets.map((d) => d.id).join(', ') || '(none)'}`,
        );
      }

      const disposable = registerCanvasWidgetType(ctx.pluginId, declaration, descriptor);
      ctx.subscriptions.push(disposable);
      return disposable;
    },

    queryWidgets(filter?: CanvasWidgetFilter): CanvasWidgetHandle[] {
      // This queries the live canvas store. We import lazily to avoid circular deps.
      // The actual widget data lives in the canvas store, which is a renderer-side concern.
      // For now, we query via the registry + any active canvas stores.
      // The full integration is wired through the canvas plugin's main.ts which
      // exposes a queryWidgets function that we call here.
      return queryCanvasWidgets(filter);
    },
  };
}

// ── Widget query implementation ────────────────────────────────────────
// This is a module-level function that the canvas plugin's main.ts wires up
// by setting the query provider. This avoids circular dependencies between
// the plugin API factory and the canvas store.

type WidgetQueryProvider = (filter?: CanvasWidgetFilter) => CanvasWidgetHandle[];

let queryProvider: WidgetQueryProvider | null = null;

/** Called by the canvas plugin to set the active query provider. */
export function setCanvasQueryProvider(provider: WidgetQueryProvider | null): void {
  queryProvider = provider;
}

function queryCanvasWidgets(filter?: CanvasWidgetFilter): CanvasWidgetHandle[] {
  if (!queryProvider) return [];
  return queryProvider(filter);
}
