import type { PluginContext, SoundsAPI } from '../../shared/plugin-types';
import { rendererLog } from './renderer-logger';

export function createSoundsAPI(ctx: PluginContext): SoundsAPI {
  return {
    async registerPack(name?: string): Promise<void> {
      // Registration is handled by the main process sound service
      // The plugin's sounds/ directory is discovered automatically
      // This is a no-op convenience — sounds are picked up from plugin path
      rendererLog(`plugin:${ctx.pluginId}`, 'info', `Sound pack registered: ${name || ctx.pluginId}`);
    },
    async unregisterPack(): Promise<void> {
      rendererLog(`plugin:${ctx.pluginId}`, 'info', 'Sound pack unregistered');
    },
    async listPacks(): Promise<Array<{ id: string; name: string; source: 'user' | 'plugin' }>> {
      const packs = await window.clubhouse.app.listSoundPacks();
      return packs.map((p) => ({ id: p.id, name: p.name, source: p.source }));
    },
  };
}
