import { useState, useEffect, useMemo } from 'react';
import type {
  MarketplacePlugin,
  MarketplaceFeaturedEntry,
  MarketplaceFetchResult,
  CustomMarketplace,
  MarketplacePluginWithSource,
} from '../../../shared/marketplace-types';
import { SUPPORTED_REGISTRY_VERSION } from '../../../shared/marketplace-types';
import { SUPPORTED_PLUGIN_API_VERSIONS, DEPRECATED_PLUGIN_API_VERSIONS } from '../../../shared/marketplace-types';
import { usePluginStore } from '../../plugins/plugin-store';
import { useProjectStore } from '../../stores/projectStore';
import { refreshCommunityPlugins } from '../../plugins/plugin-loader';
import { PERMISSION_DESCRIPTIONS, PERMISSION_RISK_LEVELS } from '../../../shared/plugin-types';
import type { PluginPermission, PermissionRiskLevel } from '../../../shared/plugin-types';
import { Spinner } from '../../components/Spinner';
import { Modal } from '../../components/Modal';
import { settingsButton, settingsInput, settingsHelp } from './SettingsLayout';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RISK_ORDER: Record<PermissionRiskLevel, number> = { safe: 0, elevated: 1, dangerous: 2 };

/** Plain-language risk words, matching the plugin detail page. */
const RISK_WORDS: Record<PermissionRiskLevel, string> = {
  safe: 'Read only',
  elevated: 'Can change things',
  dangerous: 'Can bypass safety',
};

const RISK_TEXT: Record<PermissionRiskLevel, string> = {
  safe: 'text-ctp-overlay1',
  elevated: 'text-ctp-subtext1',
  dangerous: 'text-ctp-error',
};

function sortPermissionsByRisk(perms: string[]): string[] {
  return [...perms].sort((a, b) => {
    const ra = PERMISSION_RISK_LEVELS[a as PluginPermission] ?? 'safe';
    const rb = PERMISSION_RISK_LEVELS[b as PluginPermission] ?? 'safe';
    return RISK_ORDER[rb] - RISK_ORDER[ra];
  });
}

type FilterTab = 'all' | 'featured' | 'official';

interface PluginCardProps {
  plugin: MarketplacePluginWithSource;
  featured?: MarketplaceFeaturedEntry;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  betaPlugin?: MarketplacePluginWithSource;
  installingBeta?: boolean;
  onInstallBeta?: () => void;
}

function PluginCard({ plugin, featured, installed, installing, onInstall, betaPlugin, installingBeta, onInstallBeta }: PluginCardProps) {
  const [showPerms, setShowPerms] = useState(false);
  const release = plugin.releases[plugin.latest];
  if (!release) return null;

  const compatible = SUPPORTED_PLUGIN_API_VERSIONS.includes(release.api);
  const deprecatedRemoval = DEPRECATED_PLUGIN_API_VERSIONS[release.api];
  const maxRisk = release.permissions.reduce<PermissionRiskLevel>((max, p) => {
    const r = PERMISSION_RISK_LEVELS[p as PluginPermission] ?? 'safe';
    return RISK_ORDER[r] > RISK_ORDER[max] ? r : max;
  }, 'safe');

  const meta = [
    plugin.official ? 'Official' : null,
    plugin.marketplaceName ?? null,
    plugin.latest,
    `by ${plugin.author}`,
    formatBytes(release.size),
  ].filter(Boolean).join(' · ');

  return (
    <div className="py-2.5 border-t border-surface-0" data-testid={`marketplace-plugin-${plugin.id}`}>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
            <span className="text-[13px] text-ctp-text">{plugin.name}</span>
            <span className="text-xs text-ctp-overlay1">{meta}</span>
          </div>
          <p className="text-xs text-ctp-overlay1 mt-px">{plugin.description}</p>
          {plugin.tags.length > 0 && (
            <p className="text-xs text-ctp-overlay0 mt-px">{plugin.tags.join(', ')}</p>
          )}
          {featured && (
            <p className="text-xs text-ctp-subtext1 mt-0.5">{featured.reason}</p>
          )}
          {!compatible && (
            <p className="text-xs text-ctp-error mt-0.5">
              Uses plugin API {release.api}, which this version of Clubhouse can&apos;t load.
            </p>
          )}
          {compatible && deprecatedRemoval && (
            <p className="text-xs text-ctp-warning mt-0.5">
              Uses plugin API {release.api}, which stops loading in {deprecatedRemoval}.
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            onClick={onInstall}
            disabled={installed || installing || !compatible}
            className={installed ? settingsButton.quiet : settingsButton.primary}
          >
            {installed ? 'Installed' : installing ? 'Installing…' : 'Install'}
          </button>
          {release.permissions.length > 0 && (
            <button
              onClick={() => setShowPerms(!showPerms)}
              className={`text-xs cursor-pointer hover:text-ctp-text ${RISK_TEXT[maxRisk]}`}
              aria-expanded={showPerms}
            >
              {maxRisk !== 'safe' ? `${RISK_WORDS[maxRisk]} · ` : ''}{showPerms ? 'Hide' : 'View'} permissions ({release.permissions.length})
            </button>
          )}
        </div>
      </div>
      {showPerms && release.permissions.length > 0 && (
        <div className="mt-2">
          {sortPermissionsByRisk(release.permissions).map((perm) => {
            const level = PERMISSION_RISK_LEVELS[perm as PluginPermission] ?? 'safe';
            return (
              <div key={perm} className="flex items-center gap-3 h-[30px] border-t border-surface-0">
                <span className="w-[190px] flex-none truncate font-mono text-xs text-ctp-text">{perm}</span>
                <span className="flex-1 min-w-0 truncate text-xs text-ctp-overlay1">
                  {(PERMISSION_DESCRIPTIONS[perm as PluginPermission] || 'Unknown permission').replace(/ \([^)]*\)$/, '')}
                </span>
                <span className={`flex-none text-xs ${RISK_TEXT[level]}`}>{RISK_WORDS[level]}</span>
              </div>
            );
          })}
        </div>
      )}
      {betaPlugin && (() => {
        const betaRelease = betaPlugin.releases[betaPlugin.latest];
        const betaCompatible = betaRelease ? SUPPORTED_PLUGIN_API_VERSIONS.includes(betaRelease.api) : false;
        return (
          <div className="mt-1.5 flex items-center gap-3">
            <p className="flex-1 min-w-0 text-xs text-ctp-subtext1">
              Beta {betaPlugin.latest} is available
              {betaPlugin.marketplaceName ? ` from ${betaPlugin.marketplaceName}` : ''}.
              {!betaCompatible && betaRelease && (
                <span className="text-ctp-error"> Uses plugin API {betaRelease.api}, which this version can&apos;t load.</span>
              )}
            </p>
            <button
              onClick={onInstallBeta}
              disabled={installingBeta || !betaCompatible}
              className={settingsButton.ghost}
            >
              {installingBeta ? 'Installing…' : 'Install beta'}
            </button>
          </div>
        );
      })()}
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
  const [betaPlugins, setBetaPlugins] = useState<Map<string, MarketplacePluginWithSource>>(new Map());
  const [installingBetaIds, setInstallingBetaIds] = useState<Set<string>>(new Set());
  const [betaInstallErrors, setBetaInstallErrors] = useState<Record<string, string>>({});
  const [showRestartPrompt, setShowRestartPrompt] = useState(false);

  const plugins = usePluginStore((s) => s.plugins);
  const installedPluginIds = useMemo(() => Object.keys(plugins), [plugins]);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const refreshOpts = useMemo(() => {
    const proj = activeProjectId ? projects.find((p) => p.id === activeProjectId) : undefined;
    return {
      activeProjectId: activeProjectId ?? undefined,
      activeProjectPath: proj?.path,
    };
  }, [activeProjectId, projects]);

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

          const officialIds = new Set(result.registry.plugins.map((p: MarketplacePlugin) => p.id));
          const allCustomPlugins: MarketplacePluginWithSource[] = [];
          const errors: Record<string, string> = {};
          const betaMap = new Map<string, MarketplacePluginWithSource>();

          const customResults = await window.clubhouse.marketplace.fetchCustomRegistries();
          for (const entry of customResults) {
            if (entry.error) {
              errors[entry.marketplace.id] = entry.error;
            } else {
              for (const plugin of entry.registry.plugins) {
                if (officialIds.has(plugin.id)) {
                  // Beta version of an official plugin — annotate the existing card
                  betaMap.set(plugin.id, {
                    ...plugin,
                    marketplaceId: entry.marketplace.id,
                    marketplaceName: entry.marketplace.name,
                  });
                } else {
                  officialIds.add(plugin.id);
                  allCustomPlugins.push({
                    ...plugin,
                    marketplaceId: entry.marketplace.id,
                    marketplaceName: entry.marketplace.name,
                  });
                }
              }
            }
          }

          if (!cancelled) {
            setCustomPlugins(allCustomPlugins);
            setCustomErrors(errors);
            setBetaPlugins(betaMap);
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
    const official: MarketplacePluginWithSource[] = data.registry.plugins.map((p): MarketplacePluginWithSource => ({
      ...p,
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
        // Full re-discovery + activation so plugin list updates immediately.
        // Pass active project context so project-scope plugins activate
        // for the current project (Mission 69).
        await refreshCommunityPlugins(refreshOpts);
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

  const handleInstallBeta = async (betaPlugin: MarketplacePluginWithSource) => {
    const release = betaPlugin.releases[betaPlugin.latest];
    if (!release) return;

    setInstallingBetaIds((prev) => new Set(prev).add(betaPlugin.id));
    setBetaInstallErrors((prev) => {
      const next = { ...prev };
      delete next[betaPlugin.id];
      return next;
    });

    try {
      const result = await window.clubhouse.marketplace.installPlugin({
        pluginId: betaPlugin.id,
        version: betaPlugin.latest,
        assetUrl: release.asset,
        sha256: release.sha256,
      });

      if (!result.success) {
        setBetaInstallErrors((prev) => ({ ...prev, [betaPlugin.id]: result.error || 'Install failed' }));
      } else {
        setShowRestartPrompt(true);
      }
    } catch (err: unknown) {
      setBetaInstallErrors((prev) => ({
        ...prev,
        [betaPlugin.id]: err instanceof Error ? err.message : 'Install failed',
      }));
    } finally {
      setInstallingBetaIds((prev) => {
        const next = new Set(prev);
        next.delete(betaPlugin.id);
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
    <Modal
      open
      onClose={onClose}
      title="Plugin marketplace"
      width="w-full max-w-2xl mx-4"
      backdropTestId="marketplace-overlay"
    >
      <div className="flex flex-col max-h-[70vh] -mt-1" data-testid="marketplace-dialog">
        {/* Header */}
        <div className="pb-3">
          {registryVersionWarning && (
            <p className="mb-2 text-xs text-ctp-warning">
              A newer registry format is available. Update Clubhouse for the best experience.
            </p>
          )}

          {customErrorEntries.length > 0 && (
            <div className="mb-2 text-xs text-ctp-error">
              {customErrorEntries.map(([id, err]) => {
                const mkt = customMarketplaces.find((m) => m.id === id);
                return (
                  <p key={id}>Couldn&apos;t load &ldquo;{mkt?.name || id}&rdquo;. {err}</p>
                );
              })}
            </div>
          )}

          {showRestartPrompt && (
            <div className="mb-2 flex items-center gap-3">
              <p className="flex-1 min-w-0 text-xs text-ctp-text">Beta installed. Restart Clubhouse to load the new version.</p>
              <button
                onClick={() => window.clubhouse.app.restart()}
                className={settingsButton.primary}
              >
                Restart now
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plugins…"
              aria-label="Search plugins"
              className={`${settingsInput} flex-1 min-w-0`}
              data-testid="marketplace-search"
            />
            <div role="tablist" aria-label="Filter plugins" className="flex h-7 p-0.5 gap-0.5 rounded-md border border-surface-1 shrink-0">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  role="tab"
                  aria-selected={activeTab === tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-2 rounded text-xs cursor-pointer transition-colors ${
                    activeTab === tab.key ? 'bg-surface-1 text-ctp-text' : 'text-ctp-overlay1 hover:text-ctp-text'
                  }`}
                  data-testid={`marketplace-tab-${tab.key}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12">
              <Spinner />
              <p className={settingsHelp}>Loading marketplace...</p>
            </div>
          )}

          {error && (
            <div className="py-12 text-center">
              <p className="text-[13px] text-ctp-error mb-1">Failed to load marketplace</p>
              <p className={settingsHelp}>{error}</p>
            </div>
          )}

          {!loading && !error && filteredPlugins.length === 0 && (
            <p className={`${settingsHelp} py-12 text-center`}>
              {search ? 'No plugins match your search.' : 'No plugins available.'}
            </p>
          )}

          {!loading && !error && filteredPlugins.length > 0 && (
            <div data-testid="marketplace-list">
              {filteredPlugins.map((plugin) => (
                <div key={plugin.id}>
                  <PluginCard
                    plugin={plugin}
                    featured={featuredMap.get(plugin.id)}
                    installed={installedPluginIds.includes(plugin.id)}
                    installing={installingIds.has(plugin.id)}
                    onInstall={() => handleInstall(plugin)}
                    betaPlugin={betaPlugins.get(plugin.id)}
                    installingBeta={installingBetaIds.has(plugin.id)}
                    onInstallBeta={() => {
                      const beta = betaPlugins.get(plugin.id);
                      if (beta) handleInstallBeta(beta);
                    }}
                  />
                  {installErrors[plugin.id] && (
                    <p className="text-xs text-ctp-error -mt-1 mb-2">{installErrors[plugin.id]}</p>
                  )}
                  {betaInstallErrors[plugin.id] && (
                    <p className="text-xs text-ctp-error -mt-1 mb-2">{betaInstallErrors[plugin.id]}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 mt-4">
          <p className={settingsHelp}>
            {data ? `${allPlugins.length} plugin(s) available` : ''}
            {customPlugins.length > 0 ? `, ${customPlugins.length} from custom stores` : ''}
          </p>
          <button
            onClick={onClose}
            className={settingsButton.ghost}
            data-testid="marketplace-close"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
