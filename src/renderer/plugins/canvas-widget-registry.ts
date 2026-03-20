// ── Canvas Widget Registry ─────────────────────────────────────────────
// Central registry for plugin-contributed canvas widget types.
// Plugins call registerWidgetType() at activation time; the canvas
// context menu and view renderer consume the registry to discover and
// render plugin widgets.

import type {
  Disposable,
  CanvasWidgetDescriptor,
  CanvasWidgetMetadata,
  PluginCanvasWidgetDeclaration,
} from '../../shared/plugin-types';

// ── Registered widget entry (manifest metadata + runtime descriptor) ──

export interface RegisteredCanvasWidget {
  /** Fully-qualified type key: "plugin:{pluginId}:{widgetId}". */
  qualifiedType: string;
  pluginId: string;
  /** Manifest-declared metadata. */
  declaration: PluginCanvasWidgetDeclaration;
  /** Runtime descriptor with React component. */
  descriptor: CanvasWidgetDescriptor;
}

type RegistryListener = () => void;

// ── Registry singleton ────────────────────────────────────────────────

const registry = new Map<string, RegisteredCanvasWidget>();
const listeners = new Set<RegistryListener>();

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // swallow — a failing listener should not break others
    }
  }
}

/** Qualify a plugin widget type to its global key. */
export function qualifyWidgetType(pluginId: string, widgetId: string): string {
  return `plugin:${pluginId}:${widgetId}`;
}

/** Parse a qualified widget type back into pluginId + widgetId. Returns null if not a plugin type. */
export function parsePluginWidgetType(qualifiedType: string): { pluginId: string; widgetId: string } | null {
  const match = qualifiedType.match(/^plugin:([^:]+):(.+)$/);
  if (!match) return null;
  return { pluginId: match[1], widgetId: match[2] };
}

/**
 * Register a canvas widget type from a plugin.
 * @param pluginId The plugin's ID.
 * @param declaration Manifest-declared widget metadata.
 * @param descriptor Runtime descriptor with React component.
 * @returns Disposable that unregisters the widget type.
 */
export function registerCanvasWidgetType(
  pluginId: string,
  declaration: PluginCanvasWidgetDeclaration,
  descriptor: CanvasWidgetDescriptor,
): Disposable {
  const key = qualifyWidgetType(pluginId, descriptor.id);
  registry.set(key, { qualifiedType: key, pluginId, declaration, descriptor });
  notifyListeners();
  return {
    dispose: () => {
      registry.delete(key);
      notifyListeners();
    },
  };
}

/** Unregister all widget types contributed by a specific plugin. */
export function unregisterAllForPlugin(pluginId: string): void {
  let changed = false;
  for (const [key, entry] of registry) {
    if (entry.pluginId === pluginId) {
      registry.delete(key);
      changed = true;
    }
  }
  if (changed) notifyListeners();
}

/** Get all registered plugin canvas widget types. */
export function getRegisteredWidgetTypes(): RegisteredCanvasWidget[] {
  return Array.from(registry.values());
}

/** Get a single registered widget type by its qualified key. */
export function getRegisteredWidgetType(qualifiedType: string): RegisteredCanvasWidget | undefined {
  return registry.get(qualifiedType);
}

/** Subscribe to registry changes. Returns a Disposable. */
export function onRegistryChange(listener: RegistryListener): Disposable {
  listeners.add(listener);
  return {
    dispose: () => { listeners.delete(listener); },
  };
}

/** Generate a display name for a plugin widget using its descriptor callback or manifest label. */
export function generatePluginWidgetDisplayName(
  entry: RegisteredCanvasWidget,
  metadata: CanvasWidgetMetadata,
): string {
  if (entry.descriptor.generateDisplayName) {
    try {
      return entry.descriptor.generateDisplayName(metadata);
    } catch {
      // fall through to label
    }
  }
  return entry.declaration.label;
}

/**
 * Pre-register a canvas widget type from a plugin's manifest declaration.
 * Uses a placeholder component that displays a loading state until the
 * real plugin activates and overwrites the entry via registerCanvasWidgetType().
 *
 * This ensures that built-in plugin widgets appear in the context menu and
 * canvas views immediately — before project-scoped plugins have activated.
 */
export function preRegisterFromManifest(
  pluginId: string,
  declaration: PluginCanvasWidgetDeclaration,
): void {
  const key = qualifyWidgetType(pluginId, declaration.id);
  // Only pre-register if nothing is registered for this key yet —
  // the real plugin may already have activated (e.g. dual-scoped plugins).
  if (registry.has(key)) return;
  const placeholder: RegisteredCanvasWidget = {
    qualifiedType: key,
    pluginId,
    declaration,
    descriptor: {
      id: declaration.id,
      component: null as unknown as React.ComponentType<any>,
      _pending: true,
    } as CanvasWidgetDescriptor & { _pending?: boolean },
  };
  registry.set(key, placeholder);
  notifyListeners();
}

/** Check whether a registered widget is still a pending placeholder. */
export function isWidgetPending(qualifiedType: string): boolean {
  const entry = registry.get(qualifiedType);
  if (!entry) return false;
  return !!(entry.descriptor as CanvasWidgetDescriptor & { _pending?: boolean })._pending;
}

/** Reset the registry (for testing). */
export function _resetRegistryForTesting(): void {
  registry.clear();
  listeners.clear();
}
