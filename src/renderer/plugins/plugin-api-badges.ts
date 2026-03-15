import type { PluginContext, BadgesAPI } from '../../shared/plugin-types';

let _badgeStoreCache: any = null;

function getBadgeStore() {
  if (_badgeStoreCache) return _badgeStoreCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _badgeStoreCache = require('../stores/badgeStore').useBadgeStore;
  } catch {
    // Test environment — return a no-op store
    _badgeStoreCache = {
      getState: () => ({
        setBadge: () => {},
        clearBadge: () => {},
        clearBySource: () => {},
        badges: {},
      }),
    };
  }
  return _badgeStoreCache;
}

/** Reset badge store cache — only for tests. */
export function _resetBadgeStoreCache(): void {
  _badgeStoreCache = null;
}

export function createBadgesAPI(ctx: PluginContext): BadgesAPI {
  const source = `plugin:${ctx.pluginId}`;

  return {
    set(options) {
      const store = getBadgeStore();
      const type = options.type;
      const value = options.value ?? 1;
      let target: { kind: 'explorer-tab'; projectId: string; tabId: string } | { kind: 'app-plugin'; pluginId: string };

      if ('tab' in options.target) {
        const projectId = ctx.projectId;
        if (!projectId) {
          throw new Error('badges.set({ target: { tab } }) requires a project context');
        }
        target = { kind: 'explorer-tab', projectId, tabId: options.target.tab };
      } else {
        target = { kind: 'app-plugin', pluginId: ctx.pluginId };
      }

      const badgeSource = `${source}:${options.key}`;
      store.getState().setBadge(badgeSource, type, value, target);
    },

    clear(key) {
      const store = getBadgeStore();
      const badgeSource = `${source}:${key}`;
      store.getState().clearBySource(badgeSource);
    },

    clearAll() {
      const store = getBadgeStore();
      store.getState().clearBySource(source);
      // Also clear any keyed badges (source:key pattern)
      const badges = store.getState().badges;
      const toRemove: string[] = [];
      for (const [id, badge] of Object.entries(badges) as [string, { source: string }][]) {
        if (badge.source.startsWith(source + ':')) {
          toRemove.push(id);
        }
      }
      for (const id of toRemove) {
        store.getState().clearBadge(id);
      }
    },
  };
}
