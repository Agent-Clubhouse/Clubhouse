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

/** The registry schema version the client understands. */
export const SUPPORTED_REGISTRY_VERSION = 1;
