import { RETIRED_PLUGINS, isRetiredPlugin } from '../../shared/retired-plugins';
import { pluginSystemReady } from '../plugins/plugin-loader';
import { usePluginStore } from '../plugins/plugin-store';
import { useToastStore } from '../stores/toastStore';

const SHOWN_KEY = 'clubhouse_retired_plugin_notices';

function readShown(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Tell a person once that an installed Workshop plugin was retired (#2756),
 * where its data went, and what replaces it. The plugin's page in Settings
 * says the same and offers the export.
 */
export async function showRetiredPluginNotices(): Promise<void> {
  await pluginSystemReady;
  const shown = readShown();
  const installed = Object.keys(usePluginStore.getState().plugins).filter((id) => isRetiredPlugin(id) && !shown.includes(id));
  if (installed.length === 0) return;
  for (const id of installed) {
    useToastStore.getState().addToast(
      `${RETIRED_PLUGINS[id].name} was retired and no longer loads. Its data is kept, and you can export it from its page in Settings > Plugins.`,
      'info',
    );
  }
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify([...shown, ...installed]));
  } catch {
    // Shown again next launch; harmless.
  }
}
