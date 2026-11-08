import { REMOVED_PLUGIN_API_VERSIONS } from '../../shared/marketplace-types';
import { isRetiredPlugin } from '../../shared/retired-plugins';
import { pluginSystemReady } from '../plugins/plugin-loader';
import { usePluginStore } from '../plugins/plugin-store';
import { useToastStore } from '../stores/toastStore';

const SHOWN_KEY = 'clubhouse_removed_plugin_api_notices';

function readShown(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Tell a person once which installed plugins stopped loading because their
 * plugin API version was removed in Clubhouse 1.0 (#2757), naming each version.
 * Each plugin's row in Settings > Plugins carries the full refusal.
 */
export async function showRemovedPluginApiNotice(): Promise<void> {
  await pluginSystemReady;
  const shown = readShown();
  const refused = Object.values(usePluginStore.getState().plugins).filter((entry) =>
    entry.status === 'incompatible'
    && REMOVED_PLUGIN_API_VERSIONS.includes(entry.manifest.engine?.api ?? 0)
    && !isRetiredPlugin(entry.manifest.id) // has its own notice
    && !shown.includes(entry.manifest.id));
  if (refused.length === 0) return;
  const names = refused.map((e) => `${e.manifest.name} (API ${e.manifest.engine.api})`).join(', ');
  const lead = refused.length === 1
    ? 'This plugin uses a plugin API version removed in Clubhouse 1.0, so it no longer loads'
    : 'These plugins use plugin API versions removed in Clubhouse 1.0, so they no longer load';
  useToastStore.getState().addToast(
    `${lead}: ${names}. Settings > Plugins has the details.`,
    'info',
  );
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify([...shown, ...refused.map((e) => e.manifest.id)]));
  } catch {
    // Shown again next launch; harmless.
  }
}
