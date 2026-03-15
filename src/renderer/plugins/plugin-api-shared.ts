import type { PluginManifest, PluginPermission } from '../../shared/plugin-types';
import { rendererLog } from './renderer-logger';
import { usePluginStore } from './plugin-store';

/**
 * Creates a Proxy that defers scope-violation errors to invocation time.
 *
 * Why not throw on property access?  React 19 dev-mode's `addObjectDiffToProperties`
 * enumerates prop values when diffing component renders.  If the `api` object is passed
 * as a prop, React will read `api.projects` (the Proxy), then inspect its properties —
 * triggering the `get` trap.  Throwing there crashes the app.
 *
 * Instead, `get` returns a function that throws when *called* (or when cast to a
 * primitive).  This keeps React's enumeration safe while still giving plugin authors a
 * clear error at the call-site.
 */
export function unavailableAPIProxy<T>(apiName: string, scope: string): T {
  return new Proxy({} as object, {
    get(_t, prop) {
      // Symbols (Symbol.toPrimitive, Symbol.iterator, $$typeof, etc.) — safe to ignore
      if (typeof prop === 'symbol') return undefined;
      // Return a callable that throws on invocation
      return function unavailable() {
        throw new Error(`api.${apiName} is not available for ${scope}-scoped plugins`);
      };
    },
  }) as T;
}

/** One-shot guard: tracks `pluginId:permission` pairs already enforced this session. */
const enforcedViolations = new Set<string>();

/** Reset enforced violations — only for tests. */
export function _resetEnforcedViolations(): void {
  enforcedViolations.clear();
}

export function handlePermissionViolation(pluginId: string, permission: PluginPermission, apiName: string): void {
  const key = `${pluginId}:${permission}`;
  if (enforcedViolations.has(key)) return;
  enforcedViolations.add(key);

  const store = usePluginStore.getState();
  const entry = store.plugins[pluginId];
  const pluginName = entry?.manifest.name ?? pluginId;

  store.recordPermissionViolation({
    pluginId,
    pluginName,
    permission,
    apiName,
    timestamp: Date.now(),
  });

  rendererLog('core:plugins', 'error', `Permission violation: plugin '${pluginId}' tried to use api.${apiName} without '${permission}' permission`);

  setTimeout(async () => {
    try {
      const loader = await import('./plugin-loader');
      await loader.deactivatePlugin(pluginId);
      const s = usePluginStore.getState();
      s.disableApp(pluginId);
      s.setPluginStatus(pluginId, 'disabled', `Disabled: used api.${apiName} without '${permission}' permission`);
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: 'app-enabled',
        value: usePluginStore.getState().appEnabled,
      });
    } catch (err) {
      rendererLog('core:plugins', 'error', `Failed to disable plugin '${pluginId}' after permission violation`, {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }, 0);
}

/**
 * Same pattern as `unavailableAPIProxy`, but for permission denial.
 * Defers errors to invocation time so React 19 dev-mode prop enumeration stays safe.
 */
export function permissionDeniedProxy<T>(pluginId: string, permission: PluginPermission, apiName: string): T {
  return new Proxy({} as object, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      return function permissionDenied() {
        handlePermissionViolation(pluginId, permission, apiName);
        throw new Error(`Plugin '${pluginId}' requires '${permission}' permission to use api.${apiName}`);
      };
    },
  }) as T;
}

/** Returns true if the manifest grants the given permission. */
export function hasPermission(manifest: PluginManifest | undefined, perm: PluginPermission): boolean {
  if (!manifest) return false;
  return Array.isArray(manifest.permissions) && manifest.permissions.includes(perm);
}

/**
 * Wraps API construction with scope check (existing) then permission check (new).
 * - scope denied → unavailableAPIProxy
 * - permission denied → permissionDeniedProxy
 * - both pass → construct API normally
 */
export function gated<T>(
  scopeAvailable: boolean,
  scopeLabel: string,
  apiName: string,
  permission: PluginPermission,
  pluginId: string,
  manifest: PluginManifest | undefined,
  construct: () => T,
): T {
  if (!scopeAvailable) return unavailableAPIProxy<T>(apiName, scopeLabel);
  if (!hasPermission(manifest, permission)) return permissionDeniedProxy<T>(pluginId, permission, apiName);
  return construct();
}
