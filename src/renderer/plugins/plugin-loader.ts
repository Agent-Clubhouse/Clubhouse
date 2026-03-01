import type { PluginContext, PluginModule, PluginManifest, PluginThemeDeclaration } from '../../shared/plugin-types';
import type { ThemeDefinition, ThemeColors, HljsColors, TerminalColors } from '../../shared/types';
import { usePluginStore } from './plugin-store';
import { validateManifest } from './manifest-validator';
import { createPluginAPI, computeDataDir } from './plugin-api-factory';
import { pluginHotkeyRegistry } from './plugin-hotkeys';
import { removeStyles } from './plugin-styles';
import { getBuiltinPlugins, getDefaultEnabledIds } from './builtin';
import { rendererLog } from './renderer-logger';
import { dynamicImportModule } from './dynamic-import';
import { registerTheme, unregisterTheme } from '../themes';

const activeContexts = new Map<string, PluginContext>();

// ── Pack plugin helpers ───────────────────────────────────────────────

/** Build a namespaced theme ID for a plugin-contributed theme. */
function packThemeId(pluginId: string, themeId: string): string {
  return `plugin:${pluginId}:${themeId}`;
}

/** Convert a plugin theme declaration to a ThemeDefinition and register it. */
function registerPackThemes(pluginId: string, themes: PluginThemeDeclaration[]): void {
  for (const decl of themes) {
    const def: ThemeDefinition = {
      id: packThemeId(pluginId, decl.id),
      name: decl.name,
      type: decl.type,
      colors: decl.colors as ThemeColors,
      hljs: decl.hljs as HljsColors,
      terminal: decl.terminal as TerminalColors,
    };
    registerTheme(def);
  }
}

/** Unregister all themes contributed by a plugin. */
function unregisterPackThemes(pluginId: string, themes: PluginThemeDeclaration[]): void {
  for (const decl of themes) {
    unregisterTheme(packThemeId(pluginId, decl.id));
  }
}

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

  // Read persisted external-plugins-enabled flag
  let externalEnabled = false;
  try {
    const persisted = await window.clubhouse.plugin.storageRead({
      pluginId: '_system',
      scope: 'global',
      key: 'external-plugins-enabled',
    });
    externalEnabled = persisted === true;
  } catch {
    // Default to disabled
  }
  store.setExternalPluginsEnabled(externalEnabled);

  // Discover community plugins (only when external plugins are enabled)
  if (externalEnabled) {
    const communityPlugins = await window.clubhouse.plugin.discoverCommunity();
    for (const { manifest: rawManifest, pluginPath, fromMarketplace } of communityPlugins) {
      const source = fromMarketplace ? 'marketplace' as const : 'community' as const;
      const result = validateManifest(rawManifest);
      if (result.valid && result.manifest) {
        store.registerPlugin(result.manifest, source, pluginPath, 'registered');
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
        store.registerPlugin(partialManifest, source, pluginPath, 'incompatible', result.errors.join('; '));
      }
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

  // Write startup marker *before* activation so a crash during init
  // will trigger safe mode on the next launch.
  await window.clubhouse.plugin.startupMarkerWrite(appEnabled);

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
    const isPack = entry.manifest.kind === 'pack';

    if (isPack) {
      // Pack plugins have no main.js — use an empty synthetic module.
      mod = {};
      store.setPluginModule(pluginId, mod);

      // Register pack contributions
      if (entry.manifest.contributes?.themes) {
        registerPackThemes(pluginId, entry.manifest.contributes.themes);
      }

      rendererLog('core:plugins', 'info', `Pack plugin "${pluginId}" activated`, {
        meta: { pluginId, themes: entry.manifest.contributes?.themes?.length ?? 0 },
      });
    } else if (entry.source === 'builtin') {
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

    if (!isPack) {
      // Create the API — for dual plugins activated at app level, set mode explicitly
      const activationMode = (!projectId && entry.manifest.scope === 'dual') ? 'app' as const : undefined;
      const api = createPluginAPI(ctx, activationMode, entry.manifest);

      // Ensure the plugin's data directory exists before activation
      try {
        const dataDirRelative = projectId ? `files/${projectId}` : 'files';
        await window.clubhouse.plugin.mkdir(pluginId, 'global', dataDirRelative);
      } catch {
        // Best-effort — don't block activation if mkdir fails
        rendererLog('core:plugins', 'warn', `Failed to create data directory for plugin "${pluginId}"`);
      }

      // Call activate if it exists
      if (mod.activate) {
        await mod.activate(ctx, api);
      }

      // Auto-register manifest-declared command hotkeys (v0.6+)
      const commands = entry.manifest.contributes?.commands;
      if (commands) {
        for (const cmd of commands) {
          if (cmd.defaultBinding) {
            const fullCmdId = `${pluginId}:${cmd.id}`;
            // Only register if the plugin didn't already register via registerWithHotkey()
            if (!pluginHotkeyRegistry.getBinding(pluginId, cmd.id)) {
              const existing = (await import('./plugin-commands')).pluginCommandRegistry;
              if (existing.has(fullCmdId)) {
                // Command handler was registered but no hotkey yet — add the hotkey
                pluginHotkeyRegistry.register(
                  pluginId, cmd.id, cmd.title,
                  (...args: unknown[]) => existing.execute(fullCmdId, ...args),
                  cmd.defaultBinding,
                  { global: cmd.global },
                );
              }
            }
          }
        }
      }
    }

    // Update status
    store.setPluginStatus(pluginId, 'activated');
    activeContexts.set(contextKey, ctx);
    store.bumpContextRevision();
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
  usePluginStore.getState().bumpContextRevision();

  // Check if any other contexts remain for this plugin
  const hasRemainingContexts = [...activeContexts.keys()].some(
    (key) => key === pluginId || key.startsWith(`${pluginId}:`)
  );

  if (!hasRemainingContexts) {
    const entry = store.plugins[pluginId];
    const isPack = entry?.manifest.kind === 'pack';

    if (isPack) {
      // Unregister pack contributions
      if (entry?.manifest.contributes?.themes) {
        unregisterPackThemes(pluginId, entry.manifest.contributes.themes);
      }
    } else {
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
    }

    // Clean up hotkeys and styles
    pluginHotkeyRegistry.clearPlugin(pluginId);
    removeStyles(pluginId);
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

/**
 * Hot-reload a community plugin after its files have been updated on disk.
 * This tears down the running plugin instance (all contexts), re-reads the
 * manifest, clears the cached module, and re-activates the plugin in all
 * scopes where it was previously active.
 *
 * Built-in plugins cannot be hot-reloaded.
 */
export async function hotReloadPlugin(pluginId: string): Promise<void> {
  const store = usePluginStore.getState();
  const entry = store.plugins[pluginId];

  if (!entry) {
    rendererLog('core:plugins', 'error', `Cannot hot-reload unknown plugin: ${pluginId}`);
    return;
  }

  if (entry.source === 'builtin') {
    rendererLog('core:plugins', 'warn', `Cannot hot-reload built-in plugin: ${pluginId}`);
    return;
  }

  rendererLog('core:plugins', 'info', `Hot-reloading plugin: ${pluginId}`);

  // 1. Collect all active contexts for this plugin so we can re-activate them
  const contextsToRestore: Array<{ projectId?: string; projectPath?: string }> = [];
  for (const [key, ctx] of activeContexts.entries()) {
    if (key === pluginId || key.startsWith(`${pluginId}:`)) {
      contextsToRestore.push({
        projectId: ctx.projectId,
        projectPath: ctx.projectPath,
      });
    }
  }

  // 2. Deactivate all contexts for this plugin
  for (const ctx of contextsToRestore) {
    await deactivatePlugin(pluginId, ctx.projectId);
  }

  // If the plugin had no active contexts, ensure full deactivation and module cleanup
  if (contextsToRestore.length === 0) {
    store.removePluginModule(pluginId);
  }

  // 3. Re-read manifest from disk
  const communityPlugins = await window.clubhouse.plugin.discoverCommunity();
  const discovered = communityPlugins.find(
    (p: { pluginPath: string }) => p.pluginPath === entry.pluginPath
  );

  if (!discovered) {
    rendererLog('core:plugins', 'error', `Plugin ${pluginId} no longer found at ${entry.pluginPath}`);
    store.setPluginStatus(pluginId, 'errored', 'Plugin files not found after update');
    return;
  }

  const validation = validateManifest(discovered.manifest);
  if (!validation.valid || !validation.manifest) {
    rendererLog('core:plugins', 'error', `Updated plugin ${pluginId} has invalid manifest`, {
      meta: { errors: validation.errors },
    });
    store.setPluginStatus(pluginId, 'incompatible', validation.errors.join('; '));
    return;
  }

  // 4. Re-register with updated manifest (preserve original source)
  store.registerPlugin(validation.manifest, entry.source, entry.pluginPath, 'registered');

  // 5. Re-activate in all contexts where it was previously active.
  //    activatePlugin catches its own errors internally and sets status to
  //    'errored', so we check the plugin status after each attempt rather
  //    than using try/catch.  We continue through all contexts so that a
  //    failure in one doesn't prevent the others from being restored.
  const activationErrors: string[] = [];
  for (const ctx of contextsToRestore) {
    await activatePlugin(pluginId, ctx.projectId, ctx.projectPath);
    const postEntry = usePluginStore.getState().plugins[pluginId];
    if (postEntry?.status === 'errored') {
      const label = ctx.projectId ? `project ${ctx.projectId}` : 'app';
      activationErrors.push(`${label}: ${postEntry.error || 'unknown error'}`);
      // Reset status to 'registered' so the next context attempt isn't skipped
      // (activatePlugin skips plugins with 'errored' status).
      usePluginStore.getState().setPluginStatus(pluginId, 'registered');
    }
  }

  // If the plugin had no project contexts but was app-enabled, re-activate at app level
  if (contextsToRestore.length === 0 && store.appEnabled.includes(pluginId)) {
    const updatedEntry = usePluginStore.getState().plugins[pluginId];
    if (updatedEntry && (updatedEntry.manifest.scope === 'app' || updatedEntry.manifest.scope === 'dual')) {
      await activatePlugin(pluginId);
      const postEntry = usePluginStore.getState().plugins[pluginId];
      if (postEntry?.status === 'errored') {
        activationErrors.push(`app: ${postEntry.error || 'unknown error'}`);
      }
    }
  }

  const finalEntry = usePluginStore.getState().plugins[pluginId];

  if (activationErrors.length > 0) {
    rendererLog('core:plugins', 'warn', `Plugin ${pluginId} hot-reloaded with activation errors`, {
      meta: { newVersion: finalEntry?.manifest.version, status: finalEntry?.status, errors: activationErrors },
    });
    throw new Error(`Hot-reload activation failed: ${activationErrors.join('; ')}`);
  }

  rendererLog('core:plugins', 'info', `Plugin ${pluginId} hot-reloaded successfully`, {
    meta: { newVersion: finalEntry?.manifest.version, status: finalEntry?.status },
  });
}

/**
 * Discover and register newly added local plugins without touching existing ones.
 * Scans ~/.clubhouse/plugins/, finds directories not yet registered in the store,
 * validates their manifests, and registers them. Returns the IDs of newly found plugins.
 */
export async function discoverNewPlugins(): Promise<string[]> {
  const store = usePluginStore.getState();
  const communityPlugins = await window.clubhouse.plugin.discoverCommunity();
  const newPluginIds: string[] = [];

  for (const { manifest: rawManifest, pluginPath, fromMarketplace } of communityPlugins) {
    const id = (rawManifest as Record<string, unknown>)?.id as string | undefined;
    if (!id || store.plugins[id]) continue; // already registered

    const source = fromMarketplace ? 'marketplace' as const : 'community' as const;
    const result = validateManifest(rawManifest);
    if (result.valid && result.manifest) {
      store.registerPlugin(result.manifest, source, pluginPath, 'registered');
      newPluginIds.push(result.manifest.id);
      rendererLog('core:plugins', 'info', `Discovered new plugin: ${result.manifest.id}`, {
        meta: { pluginPath, source },
      });
    } else {
      rendererLog('core:plugins', 'warn', `New plugin incompatible: ${pluginPath}`, {
        meta: { pluginPath, errors: result.errors },
      });
      const partialManifest: PluginManifest = {
        id: id || pluginPath.split('/').pop() || 'unknown',
        name: (rawManifest as Record<string, unknown>)?.name as string || 'Unknown Plugin',
        version: (rawManifest as Record<string, unknown>)?.version as string || '0.0.0',
        engine: { api: 0 },
        scope: 'project',
      };
      store.registerPlugin(partialManifest, source, pluginPath, 'incompatible', result.errors.join('; '));
      newPluginIds.push(partialManifest.id);
    }
  }

  return newPluginIds;
}

/** @internal — only for tests */
export function _resetActiveContexts(): void {
  activeContexts.clear();
}
