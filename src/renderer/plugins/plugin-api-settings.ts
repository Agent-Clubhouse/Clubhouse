import type { PluginContext, SettingsAPI, Disposable } from '../../shared/plugin-types';
import { usePluginStore } from './plugin-store';

export function createSettingsAPI(ctx: PluginContext): SettingsAPI {
  const settingsScope = (ctx.scope === 'project' || ctx.scope === 'dual') && ctx.projectId
    ? ctx.projectId
    : 'app';
  const settingsKey = `${settingsScope}:${ctx.pluginId}`;
  const changeHandlers = new Set<(key: string, value: unknown) => void>();

  // Subscribe to store changes and dispatch to changeHandlers
  let prevSettings = usePluginStore.getState().pluginSettings[settingsKey] || {};
  const unsub = usePluginStore.subscribe((state) => {
    const newSettings = state.pluginSettings[settingsKey] || {};
    if (newSettings !== prevSettings) {
      // Find changed keys by comparing old and new
      const allKeys = new Set([...Object.keys(prevSettings), ...Object.keys(newSettings)]);
      for (const key of allKeys) {
        if (newSettings[key] !== prevSettings[key]) {
          changeHandlers.forEach(handler => handler(key, newSettings[key]));
        }
      }
      prevSettings = newSettings;
    }
  });
  ctx.subscriptions.push({ dispose: unsub });

  return {
    get<T = unknown>(key: string): T | undefined {
      const allSettings = usePluginStore.getState().pluginSettings[settingsKey];
      return allSettings?.[key] as T | undefined;
    },
    getAll(): Record<string, unknown> {
      return usePluginStore.getState().pluginSettings[settingsKey] || {};
    },
    set(key: string, value: unknown): void {
      usePluginStore.getState().setPluginSetting(settingsScope, ctx.pluginId, key, value);
    },
    onChange(callback: (key: string, value: unknown) => void): Disposable {
      changeHandlers.add(callback);
      return {
        dispose: () => { changeHandlers.delete(callback); },
      };
    },
  };
}
