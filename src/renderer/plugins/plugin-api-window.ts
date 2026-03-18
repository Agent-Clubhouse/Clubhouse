import type { PluginContext, PluginManifest, WindowAPI } from '../../shared/plugin-types';
import { usePluginStore } from './plugin-store';

/**
 * Resolve the manifest default title for this plugin.
 * Priority: contributes.tab.title > contributes.tab.label >
 *           contributes.railItem.title > contributes.railItem.label > manifest.name
 */
function getManifestDefaultTitle(manifest?: PluginManifest): string {
  if (!manifest) return '';
  const tab = manifest.contributes?.tab;
  const rail = manifest.contributes?.railItem;
  return tab?.title || tab?.label || rail?.title || rail?.label || manifest.name;
}

export function createWindowAPI(ctx: PluginContext, manifest?: PluginManifest): WindowAPI {
  const pluginId = ctx.pluginId;
  const defaultTitle = getManifestDefaultTitle(manifest);

  return {
    setTitle(title: string): void {
      usePluginStore.getState().setPluginTitle(pluginId, title);
    },

    resetTitle(): void {
      usePluginStore.getState().clearPluginTitle(pluginId);
    },

    getTitle(): string {
      const dynamic = usePluginStore.getState().pluginTitles[pluginId];
      return dynamic ?? defaultTitle;
    },
  };
}
