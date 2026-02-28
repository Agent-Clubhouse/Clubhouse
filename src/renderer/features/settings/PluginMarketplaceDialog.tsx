import { useState, useEffect, useMemo, useRef } from 'react';
import type {
  MarketplacePlugin,
  MarketplaceFeaturedEntry,
  MarketplaceFetchResult,
  CustomMarketplace,
  MarketplacePluginWithSource,
} from '../../../shared/marketplace-types';
import { SUPPORTED_REGISTRY_VERSION } from '../../../shared/marketplace-types';
import { SUPPORTED_API_VERSIONS } from '../../plugins/manifest-validator';
import { usePluginStore } from '../../plugins/plugin-store';
import { PERMISSION_DESCRIPTIONS } from '../../../shared/plugin-types';
import type { PluginPermission } from '../../../shared/plugin-types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type FilterTab = 'all' | 'featured' | 'official';

interface PluginCardProps {
  plugin: MarketplacePluginWithSource;
  featured?: MarketplaceFeaturedEntry;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}

function PluginCard({ plugin, featured, installed, installing, onInstall }: PluginCardProps) {
  const release = plugin.releases[plugin.latest];
  if (!release) return null;

  const compatible = SUPPORTED_API_VERSIONS.includes(release.api);
  const [showPerms, setShowPerms] = useState(false);

  return (
    <div className="p-4 rounded-lg bg-ctp-mantle border border-surface-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-ctp-text">{plugin.name}</span>
            <span className="text-xs text-ctp-subtext0">v{plugin.latest}</span>
            {plugin.official && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">Official</span>
            )}
            {plugin.marketplaceName && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
                {plugin.marketplaceName}
              </span>
            )}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-ctp-overlay1">
              API {release.api}
            </span>
            {!compatible && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Incompatible</span>
            )}
            {installed && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-ctp-accent/20 text-ctp-accent">Installed</span>
            )}
          </div>
          <p className="text-xs text-ctp-subtext0 mt-1">{plugin.description}</p>
          <div className="flex items-center gap-3 mt-2 text-[10px] text-ctp-subtext0">
            <span>by {plugin.author}</span>
            <span>{formatBytes(release.size)}</span>
          </div>
          {plugin.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {plugin.tags.map((tag) => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-0 text-ctp-subtext0">
                  {tag}
                </span>
              ))}
            </div>
          )}
          {featured && (
            <p className="text-[11px] text-ctp-accent mt-2 italic">{featured.reason}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={onInstall}
            disabled={installed || installing || !compatible}
            className={`
              px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer
              ${installed
                ? 'bg-surface-1 text-ctp-subtext0 cursor-default'
                : !compatible
                  ? 'bg-surface-1 text-ctp-subtext0 cursor-not-allowed opacity-50'
                  : installing
                    ? 'bg-ctp-accent/50 text-white cursor-wait'
                    : 'bg-ctp-accent text-white hover:bg-ctp-accent/90'}
            `}
          >
            {installed ? 'Installed' : installing ? 'Installing...' : 'Install'}
          </button>
          {release.permissions.length > 0 && (
            <button
              onClick={() => setShowPerms(!showPerms)}
              className="text-[10px] text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
            >
              {showPerms ? 'Hide' : 'View'} permissions ({release.permissions.length})
            </button>
          )}
        </div>
      </div>
      {showPerms && release.permissions.length > 0 && (
        <div className="mt-3 pt-3 border-t border-surface-0 space-y-1.5">
          {release.permissions.map((perm) => (
            <div key={perm}>
              <span className="text-xs font-mono text-ctp-accent">{perm}</span>
              <p className="text-[10px] text-ctp-subtext0">
                {PERMISSION_DESCRIPTIONS[perm as PluginPermission] || 'Unknown permission'}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PluginMarketplaceDialog({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MarketplaceFetchResult | null>(null);
  const [customMarketplaces, setCustomMarketplaces] = useState<CustomMarketplace[]>([]);
  const [customPlugins, setCustomPlugins] = useState<MarketplacePluginWithSource[]>([]);
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [registryVersionWarning, setRegistryVersionWarning] = useState(false);

  const plugins = usePluginStore((s) => s.plugins);
  const installedPluginIds = useMemo(() => Object.keys(plugins), [plugins]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Fetch official registry
        const result = await window.clubhouse.marketplace.fetchRegistry();
        if (cancelled) return;
        if (result.registry.version > SUPPORTED_REGISTRY_VERSION) {
          setRegistryVersionWarning(true);
        }
        setData(result);

        // Fetch custom marketplace registries
        try {
          const customs = await window.clubhouse.marketplace.listCustomMarketplaces();
          if (cancelled) return;
          setCustomMarketplaces(customs);

          const enabledCustoms = customs.filter((m: CustomMarketplace) => m.enabled);
          const officialIds = new Set(result.registry.plugins.map((p: MarketplacePlugin) => p.id));
          const allCustomPlugins: MarketplacePluginWithSource[] = [];
          const errors: Record<string, string> = {};

          // Fetch each custom marketplace
          await Promise.allSettled(
            enabledCustoms.map(async (m: CustomMarketplace) => {
              try {
                // Fetch the custom registry.json directly
                const res = await window.fetch(m.url);
                if (!res.ok) {
                  throw new Error(`HTTP ${res.status}`);
                }
                const registry = await res.json();
                if (registry.plugins && Array.isArray(registry.plugins)) {
                  for (const plugin of registry.plugins) {
                    if (!officialIds.has(plugin.id)) {
                      officialIds.add(plugin.id);
                      allCustomPlugins.push({
                        ...plugin,
                        marketplaceId: m.id,
                        marketplaceName: m.name,
                      });
                    }
                  }
                }
              } catch (err: unknown) {
                errors[m.id] = err instanceof Error ? err.message : String(err);
              }
            }),
          );

          if (!cancelled) {
            setCustomPlugins(allCustomPlugins);
            setCustomErrors(errors);
          }
        } catch {
          // Custom marketplaces are non-critical
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch registry');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const featuredMap = useMemo(() => {
    const map = new Map<string, MarketplaceFeaturedEntry>();
    if (data?.featured) {
      for (const f of data.featured.featured) {
        map.set(f.id, f);
      }
    }
    return map;
  }, [data]);

  // Merge official and custom plugins into a unified list
  const allPlugins: MarketplacePluginWithSource[] = useMemo(() => {
    if (!data) return [];
    const official: MarketplacePluginWithSource[] = data.registry.plugins.map((p) => ({
      ...p,
      marketplaceId: undefined,
      marketplaceName: undefined,
    }));
    return [...official, ...customPlugins];
  }, [data, customPlugins]);

  const filteredPlugins = useMemo(() => {
    let plugins = allPlugins;

    // Tab filter
    if (activeTab === 'featured') {
      plugins = plugins.filter((p) => featuredMap.has(p.id));
    } else if (activeTab === 'official') {
      plugins = plugins.filter((p) => p.official);
    }

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      plugins = plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          (p.marketplaceName && p.marketplaceName.toLowerCase().includes(q)),
      );
    }

    return plugins;
  }, [allPlugins, activeTab, search, featuredMap]);

  const handleInstall = async (plugin: MarketplacePluginWithSource) => {
    const release = plugin.releases[plugin.latest];
    if (!release) return;

    setInstallingIds((prev) => new Set(prev).add(plugin.id));
    setInstallErrors((prev) => {
      const next = { ...prev };
      delete next[plugin.id];
      return next;
    });

    try {
      const result = await window.clubhouse.marketplace.installPlugin({
        pluginId: plugin.id,
        version: plugin.latest,
        assetUrl: release.asset,
        sha256: release.sha256,
      });

      if (!result.success) {
        setInstallErrors((prev) => ({ ...prev, [plugin.id]: result.error || 'Install failed' }));
      } else {
        // Re-discover community plugins so the store picks it up
        const discovered = await window.clubhouse.plugin.discoverCommunity();
        const match = discovered.find((d: { manifest: { id: string } }) => d.manifest.id === plugin.id);
        if (match) {
          usePluginStore.getState().registerPlugin(match.manifest, 'community', match.pluginPath, 'registered');
        }
      }
    } catch (err: unknown) {
      setInstallErrors((prev) => ({
        ...prev,
        [plugin.id]: err instanceof Error ? err.message : 'Install failed',
      }));
    } finally {
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(plugin.id);
        return next;
      });
    }
  };

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'featured', label: 'Featured' },
    { key: 'official', label: 'Official' },
  ];

  const customErrorEntries = Object.entries(customErrors);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      data-testid="marketplace-overlay"
    >
      <div
        className="bg-ctp-base border border-surface-2 rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
        data-testid="marketplace-dialog"
      >
        {/* Header */}
        <div className="p-6 pb-4 border-b border-surface-1">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-ctp-text">Plugin Marketplace</h3>
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-surface-1 text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
              data-testid="marketplace-close"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {registryVersionWarning && (
            <div className="mb-3 p-2 rounded bg-ctp-peach/20 border border-ctp-peach/40 text-xs text-ctp-peach">
              A newer registry format is available. Update Clubhouse for the best experience.
            </div>
          )}

          {customErrorEntries.length > 0 && (
            <div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">
              {customErrorEntries.map(([id, err]) => {
                const mkt = customMarketplaces.find((m) => m.id === id);
                return (
                  <p key={id}>Failed to load "{mkt?.name || id}": {err}</p>
                );
              })}
            </div>
          )}

          {/* Search */}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plugins..."
            className="w-full px-3 py-2 rounded-lg bg-surface-0 border border-surface-1 text-sm text-ctp-text placeholder-ctp-subtext0 outline-none focus:border-ctp-accent"
            data-testid="marketplace-search"
          />

          {/* Tabs */}
          <div className="flex gap-1 mt-3">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`
                  px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer
                  ${activeTab === tab.key
                    ? 'bg-ctp-accent text-white'
                    : 'bg-surface-0 text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-1'}
                `}
                data-testid={`marketplace-tab-${tab.key}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 pt-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-ctp-subtext0">Loading marketplace...</p>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <p className="text-sm text-red-400 mb-2">Failed to load marketplace</p>
                <p className="text-xs text-ctp-subtext0">{error}</p>
              </div>
            </div>
          )}

          {!loading && !error && filteredPlugins.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-ctp-subtext0">
                {search ? 'No plugins match your search.' : 'No plugins available.'}
              </p>
            </div>
          )}

          {!loading && !error && filteredPlugins.length > 0 && (
            <div className="space-y-3">
              {filteredPlugins.map((plugin) => (
                <div key={plugin.id}>
                  <PluginCard
                    plugin={plugin}
                    featured={featuredMap.get(plugin.id)}
                    installed={installedPluginIds.includes(plugin.id)}
                    installing={installingIds.has(plugin.id)}
                    onInstall={() => handleInstall(plugin)}
                  />
                  {installErrors[plugin.id] && (
                    <p className="text-xs text-red-400 mt-1 px-1">{installErrors[plugin.id]}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-surface-1 flex items-center justify-between">
          <p className="text-[10px] text-ctp-subtext0">
            {data ? `${allPlugins.length} plugin(s) available` : ''}
            {customPlugins.length > 0 ? ` (${customPlugins.length} from custom registries)` : ''}
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded bg-surface-0 border border-surface-2 text-sm text-ctp-text hover:bg-surface-1 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
