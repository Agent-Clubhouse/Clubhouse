// ── Marketplace registry types ────────────────────────────────────────
// Mirrors the JSON schema from Agent-Clubhouse/Clubhouse-Workshop registry

export interface MarketplaceRelease {
  api: number;
  asset: string;
  sha256: string;
  permissions: string[];
  size: number;
}

export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  official: boolean;
  repo: string;
  path: string;
  tags: string[];
  latest: string;
  releases: Record<string, MarketplaceRelease>;
}

export interface MarketplaceRegistry {
  version: number;
  updated: string;
  plugins: MarketplacePlugin[];
}

export interface MarketplaceFeaturedEntry {
  id: string;
  reason: string;
}

export interface MarketplaceFeatured {
  version: number;
  updated: string;
  featured: MarketplaceFeaturedEntry[];
}

// ── IPC request/response types ───────────────────────────────────────

export interface MarketplaceFetchResult {
  registry: MarketplaceRegistry;
  featured: MarketplaceFeatured | null;
}

export interface MarketplaceInstallRequest {
  pluginId: string;
  version: string;
  assetUrl: string;
  sha256: string;
}

export interface MarketplaceInstallResult {
  success: boolean;
  error?: string;
}

// ── Plugin update types ─────────────────────────────────────────────

export interface PluginUpdateInfo {
  pluginId: string;
  pluginName: string;
  currentVersion: string;
  latestVersion: string;
  assetUrl: string;
  sha256: string;
  size: number;
}

export interface PluginUpdateCheckResult {
  updates: PluginUpdateInfo[];
  checkedAt: string;
}

export interface PluginUpdateRequest {
  pluginId: string;
}

export interface PluginUpdateResult {
  success: boolean;
  pluginId: string;
  newVersion?: string;
  error?: string;
}

export interface PluginUpdatesStatus {
  updates: PluginUpdateInfo[];
  checking: boolean;
  lastCheck: string | null;
  /** pluginId -> 'downloading' | 'installing' | 'reloading' */
  updating: Record<string, string>;
  error: string | null;
}

/** The registry schema version the client understands. */
export const SUPPORTED_REGISTRY_VERSION = 1;

// ── Custom marketplace types ─────────────────────────────────────────

export interface CustomMarketplace {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface CustomMarketplaceAddRequest {
  name: string;
  url: string;
}

export interface CustomMarketplaceRemoveRequest {
  id: string;
}

export interface CustomMarketplaceToggleRequest {
  id: string;
  enabled: boolean;
}

/**
 * Extended fetch result that includes plugins from all registries
 * (official + custom), each tagged with their source marketplace.
 */
export interface MarketplacePluginWithSource extends MarketplacePlugin {
  /** Which marketplace this plugin came from. undefined = official. */
  marketplaceId?: string;
  /** Display name of the source marketplace. */
  marketplaceName?: string;
}
