import type { PluginContext, PluginModule, PluginManifest } from '../../shared/plugin-types';
import { usePluginStore } from './plugin-store';
import { validateManifest } from './manifest-validator';
import { createPluginAPI } from './plugin-api-factory';
import { injectStyles, removeStyles } from './plugin-styles';
import { getBuiltinPlugins, getDefaultEnabledIds } from './builtin';
import { rendererLog } from './renderer-logger';
import { dynamicImportModule } from './dynamic-import';

const activeContexts = new Map<string, PluginContext>();

/** Returns IDs of built-in plugins that should be auto-enabled per project. */
export function getBuiltinProjectPluginIds(): string[] {
  const defaults = getDefaultEnabledIds();
  return getBuiltinPlugins()
    .filter(({ manifest }) =>
      defaults.has(manifest.id) &&
      (manifest.scope === 'project' || manifest.scope === 'dual'),
    )
    .map(({ manifest }) => manifest.id);
}

export async function initializePluginSystem(): Promise<void> {
  const store = usePluginStore.getState();

  // Check safe mode
  const marker = await window.clubhouse.plugin.startupMarkerRead();
  if (marker && marker.attempt >= 2) {
    store.setSafeModeActive(true);
    rendererLog('core:plugins', 'warn', 'Safe mode active — no plugins will be loaded', {
      meta: { attempt: marker.attempt, lastEnabledPlugins: marker.lastEnabledPlugins },
    });
    return;
  }

  rendererLog('core:plugins', 'info', 'Initializing plugin system');

  // Register built-in plugins
  const builtins = getBuiltinPlugins();
  const defaults = getDefaultEnabledIds();
  for (const { manifest, module: mod } of builtins) {
    store.registerPlugin(manifest, 'builtin', '', 'registered');
    store.setPluginModule(manifest.id, mod);
    // Only auto-enable default plugins at app level (app-level acts as availability gate for all scopes)
    if (defaults.has(manifest.id)) {
      store.enableApp(manifest.id);
    }
  }

  // Discover community plugins
  const communityPlugins = await window.clubhouse.plugin.discoverCommunity();
  for (const { manifest: rawManifest, pluginPath } of communityPlugins) {
    const result = validateManifest(rawManifest);
    if (result.valid && result.manifest) {
      store.registerPlugin(result.manifest, 'community', pluginPath, 'registered');
    } else {
      rendererLog('core:plugins', 'warn', `Community plugin incompatible: ${pluginPath}`, {
        meta: { pluginPath, errors: result.errors },
      });
      // Register as incompatible so it appears in settings
      const partialManifest: PluginManifest = {
        id: (rawManifest as Record<string, unknown>)?.id as string || pluginPath.split('/').pop() || 'unknown',
        name: (rawManifest as Record<string, unknown>)?.name as string || 'Unknown Plugin',
        version: (rawManifest as Record<string, unknown>)?.version as string || '0.0.0',
        engine: { api: 0 },
        scope: 'project',
      };
      store.registerPlugin(partialManifest, 'community', pluginPath, 'incompatible', result.errors.join('; '));
    }
  }

  // Load persisted enabled lists
  // App-level config — merge with auto-enabled builtins so new builtins are always included
  try {
    const appConfig = await window.clubhouse.plugin.storageRead({
      pluginId: '_system',
      scope: 'global',
      key: 'app-enabled',
    }) as string[] | undefined;
    if (Array.isArray(appConfig)) {
      // Merge: persisted list + any auto-enabled builtins not already present
      const currentAppEnabled = usePluginStore.getState().appEnabled;
      const merged = [...new Set([...appConfig, ...currentAppEnabled])];
      store.loadAppPluginConfig(merged);
    }
  } catch {
    // No saved config — auto-enabled builtins remain
  }

  // Activate app-scoped and dual-scoped plugins that are in appEnabled
  const appEnabled = usePluginStore.getState().appEnabled;
  for (const pluginId of appEnabled) {
    const entry = store.plugins[pluginId];
    if (entry && (entry.manifest.scope === 'app' || entry.manifest.scope === 'dual')) {
      await activatePlugin(pluginId);
    }
  }

  // Clear startup marker after successful init
  await window.clubhouse.plugin.startupMarkerClear();

  const state = usePluginStore.getState();
  const pluginCount = Object.keys(state.plugins).length;
  const activeCount = Object.values(state.plugins).filter((p) => p.status === 'activated').length;
  rendererLog('core:plugins', 'info', 'Plugin system initialized', {
    meta: { pluginCount, activeCount, appEnabled: state.appEnabled },
  });
}

export async function activatePlugin(
  pluginId: string,
  projectId?: string,
  projectPath?: string,
): Promise<void> {
  const store = usePluginStore.getState();
  const entry = store.plugins[pluginId];
  if (!entry) {
    rendererLog('core:plugins', 'error', `Cannot activate unknown plugin: ${pluginId}`);
    return;
  }

  if (entry.status === 'incompatible' || entry.status === 'errored' || entry.status === 'disabled') {
    rendererLog('core:plugins', 'warn', `Skipping activation of ${pluginId}: ${entry.status}`, {
      meta: { pluginId, status: entry.status, error: entry.error },
    });
    return;
  }

  const contextKey = projectId ? `${pluginId}:${projectId}` : pluginId;
  if (activeContexts.has(contextKey)) {
    return; // Already activated
  }

  const ctx: PluginContext = {
    pluginId,
    pluginPath: entry.pluginPath,
    scope: entry.manifest.scope,
    projectId,
    projectPath,
    subscriptions: [],
    settings: {},
  };

  // Load settings — try in-memory store first, then persist from disk
  const settingsKey = projectId ? `${projectId}:${pluginId}` : `app:${pluginId}`;
  let savedSettings = store.pluginSettings[settingsKey];
  if (!savedSettings) {
    try {
      const scope = projectId || 'app';
      const persisted = await window.clubhouse.plugin.storageRead({
        pluginId: '_system',
        scope: 'global',
        key: `settings-${scope}-${pluginId}`,
      }) as Record<string, unknown> | undefined;
      if (persisted && typeof persisted === 'object') {
        store.loadPluginSettings(settingsKey, persisted);
        savedSettings = persisted;
      }
    } catch {
      // No persisted settings — use defaults
    }
  }
  if (savedSettings) {
    ctx.settings = { ...savedSettings };
  }

  try {
    let mod: PluginModule;

    if (entry.source === 'builtin') {
      // Built-in plugins already have their module set during registration
      mod = store.modules[pluginId];
      if (!mod) {
        rendererLog('core:plugins', 'error', `Built-in plugin ${pluginId} has no module`);
        return;
      }
    } else {
      // Dynamic import for community plugins
      const mainPath = entry.manifest.main || 'main.js';
      const fullModulePath = `${entry.pluginPath}/${mainPath}`;

      // Convert filesystem path to file:// URL for ESM import resolution.
      // On macOS/Linux paths start with '/', on Windows they start with a drive letter.
      const moduleUrl = fullModulePath.startsWith('/')
        ? `file://${fullModulePath}`
        : `file:///${fullModulePath.replace(/\\/g, '/')}`;

      // Append cache-busting param so re-imports after plugin rebuild
      // don't return the stale cached module.
      const cacheBustedUrl = `${moduleUrl}?v=${Date.now()}`;

      try {
        mod = await dynamicImportModule(cacheBustedUrl);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack : undefined;
        rendererLog('core:plugins', 'error', `Failed to load module for plugin "${pluginId}"`, {
          meta: { pluginId, modulePath: fullModulePath, moduleUrl: cacheBustedUrl, error: errMsg, stack: errStack },
        });
        store.setPluginStatus(pluginId, 'errored', `Failed to load module: ${errMsg}`);
        return;
      }

      // Validate that the loaded module has expected exports
      if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) {
        const errMsg = `Plugin module at "${fullModulePath}" did not export a valid module object`;
        rendererLog('core:plugins', 'error', errMsg, { meta: { pluginId, modulePath: fullModulePath } });
        store.setPluginStatus(pluginId, 'errored', errMsg);
        return;
      }

      store.setPluginModule(pluginId, mod);
    }

    // Create the API — for dual plugins activated at app level, set mode explicitly
    const activationMode = (!projectId && entry.manifest.scope === 'dual') ? 'app' as const : undefined;
    const api = createPluginAPI(ctx, activationMode, entry.manifest);

    // Call activate if it exists
    if (mod.activate) {
      await mod.activate(ctx, api);
    }

    // Update status
    store.setPluginStatus(pluginId, 'activated');
    activeContexts.set(contextKey, ctx);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    rendererLog('core:plugins', 'error', `Error activating plugin "${pluginId}"`, {
      meta: { pluginId, source: entry.source, error: errMsg, stack: errStack },
    });
    // Store a detailed error: message on first line, stack on subsequent lines
    const errorDetail = errStack ? `Activation failed: ${errMsg}\n${errStack}` : `Activation failed: ${errMsg}`;
    store.setPluginStatus(pluginId, 'errored', errorDetail);
  }
}

export async function deactivatePlugin(pluginId: string, projectId?: string): Promise<void> {
  const store = usePluginStore.getState();
  const contextKey = projectId ? `${pluginId}:${projectId}` : pluginId;
  const ctx = activeContexts.get(contextKey);

  if (!ctx) return;

  // Dispose subscriptions in reverse order
  const subs = [...ctx.subscriptions].reverse();
  for (const sub of subs) {
    try {
      sub.dispose();
    } catch (err) {
      rendererLog('core:plugins', 'error', `Error disposing subscription for ${pluginId}`, {
        meta: { pluginId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Remove this context
  activeContexts.delete(contextKey);

  // Check if any other contexts remain for this plugin
  const hasRemainingContexts = [...activeContexts.keys()].some(
    (key) => key === pluginId || key.startsWith(`${pluginId}:`)
  );

  if (!hasRemainingContexts) {
    // Call deactivate on the module only when all contexts are gone
    const mod = store.modules[pluginId];
    if (mod?.deactivate) {
      try {
        await mod.deactivate();
      } catch (err) {
        rendererLog('core:plugins', 'error', `Error in deactivate for ${pluginId}`, {
          meta: { pluginId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    // Clean up styles and global status
    removeStyles(pluginId);
    const entry = store.plugins[pluginId];
    if (entry?.source !== 'builtin') {
      store.removePluginModule(pluginId);
    }
    store.setPluginStatus(pluginId, 'deactivated');
  }
}

export async function handleProjectSwitch(
  oldProjectId: string | null,
  newProjectId: string,
  newProjectPath: string,
): Promise<void> {
  const store = usePluginStore.getState();

  // Deactivate project-scoped and dual-scoped plugins for the old project
  if (oldProjectId) {
    const oldEnabled = store.projectEnabled[oldProjectId] || [];
    for (const pluginId of oldEnabled) {
      const entry = store.plugins[pluginId];
      if (entry && (entry.manifest.scope === 'project' || entry.manifest.scope === 'dual')) {
        await deactivatePlugin(pluginId, oldProjectId);
      }
    }
  }

  // Activate project-scoped and dual-scoped plugins for the new project
  // Only activate if the plugin is also enabled at app level (app-first gate)
  const newEnabled = store.projectEnabled[newProjectId] || [];
  for (const pluginId of newEnabled) {
    const entry = store.plugins[pluginId];
    if (entry && (entry.manifest.scope === 'project' || entry.manifest.scope === 'dual')) {
      if (!store.appEnabled.includes(pluginId)) continue;
      await activatePlugin(pluginId, newProjectId, newProjectPath);
    }
  }
}

export function getActiveContext(pluginId: string, projectId?: string): PluginContext | undefined {
  const contextKey = projectId ? `${pluginId}:${projectId}` : pluginId;
  return activeContexts.get(contextKey);
}

/** @internal — only for tests */
export function _resetActiveContexts(): void {
  activeContexts.clear();
}
