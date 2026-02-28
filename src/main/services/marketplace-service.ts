import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import AdmZip from 'adm-zip';
import { appLog } from './log-service';
import type {
  MarketplaceRegistry,
  MarketplaceFeatured,
  MarketplaceFetchResult,
  MarketplaceInstallRequest,
  MarketplaceInstallResult,
  CustomMarketplace,
  MarketplacePluginWithSource,
} from '../../shared/marketplace-types';
import { SUPPORTED_REGISTRY_VERSION } from '../../shared/marketplace-types';

const REGISTRY_URL =
  'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse-Workshop/main/registry/registry.json';
const FEATURED_URL =
  'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse-Workshop/main/registry/featured.json';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let registryCache: { data: MarketplaceFetchResult; fetchedAt: number } | null = null;

/** Per-custom-marketplace cache keyed by marketplace id */
const customRegistryCache = new Map<string, { data: MarketplaceRegistry; fetchedAt: number }>();

/** @internal Reset cache — exported for tests only. */
export function _resetCache(): void {
  registryCache = null;
  customRegistryCache.clear();
}

function getCommunityPluginsDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'plugins');
}

export async function fetchRegistry(): Promise<MarketplaceFetchResult> {
  // Return cached if fresh
  if (registryCache && Date.now() - registryCache.fetchedAt < CACHE_TTL_MS) {
    return registryCache.data;
  }

  appLog('marketplace', 'info', 'Fetching plugin registry');

  const registryRes = await fetch(REGISTRY_URL);
  if (!registryRes.ok) {
    throw new Error(`Failed to fetch registry: ${registryRes.status} ${registryRes.statusText}`);
  }
  const registry: MarketplaceRegistry = await registryRes.json();

  let featured: MarketplaceFeatured | null = null;
  try {
    const featuredRes = await fetch(FEATURED_URL);
    if (featuredRes.ok) {
      featured = await featuredRes.json();
    }
  } catch {
    // Featured list is optional — non-fatal
    appLog('marketplace', 'warn', 'Could not fetch featured.json');
  }

  const result: MarketplaceFetchResult = { registry, featured };
  registryCache = { data: result, fetchedAt: Date.now() };

  appLog('marketplace', 'info', `Registry loaded: ${registry.plugins.length} plugin(s)`);
  return result;
}

/**
 * Fetch a custom marketplace registry from its URL.
 * The URL should point to a registry.json following the same schema as the official registry.
 * A featured.json can optionally be co-located (same directory as registry.json).
 */
export async function fetchCustomRegistry(marketplace: CustomMarketplace): Promise<{
  registry: MarketplaceRegistry;
  featured: MarketplaceFeatured | null;
}> {
  // Check cache
  const cached = customRegistryCache.get(marketplace.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { registry: cached.data, featured: null };
  }

  appLog('marketplace', 'info', `Fetching custom registry: ${marketplace.name} (${marketplace.url})`);

  const registryRes = await fetch(marketplace.url);
  if (!registryRes.ok) {
    throw new Error(`Failed to fetch custom registry "${marketplace.name}": ${registryRes.status} ${registryRes.statusText}`);
  }
  const registry: MarketplaceRegistry = await registryRes.json();

  if (registry.version > SUPPORTED_REGISTRY_VERSION) {
    appLog('marketplace', 'warn', `Custom registry "${marketplace.name}" uses version ${registry.version}, client supports ${SUPPORTED_REGISTRY_VERSION}`);
  }

  // Try to fetch featured.json from the same directory
  let featured: MarketplaceFeatured | null = null;
  try {
    const baseUrl = marketplace.url.replace(/\/[^/]*$/, '');
    const featuredUrl = `${baseUrl}/featured.json`;
    const featuredRes = await fetch(featuredUrl);
    if (featuredRes.ok) {
      featured = await featuredRes.json();
    }
  } catch {
    // Featured is optional
  }

  customRegistryCache.set(marketplace.id, { data: registry, fetchedAt: Date.now() });

  appLog('marketplace', 'info', `Custom registry "${marketplace.name}" loaded: ${registry.plugins.length} plugin(s)`);
  return { registry, featured };
}

/**
 * Fetch the official registry plus all enabled custom marketplaces.
 * Returns a unified list of plugins with source marketplace tags.
 */
export async function fetchAllRegistries(customMarketplaces: CustomMarketplace[]): Promise<{
  official: MarketplaceFetchResult;
  custom: Array<{
    marketplace: CustomMarketplace;
    registry: MarketplaceRegistry;
    featured: MarketplaceFeatured | null;
    error?: string;
  }>;
  allPlugins: MarketplacePluginWithSource[];
}> {
  // Fetch official registry
  const official = await fetchRegistry();

  // Tag official plugins
  const allPlugins: MarketplacePluginWithSource[] = official.registry.plugins.map((p): MarketplacePluginWithSource => ({
    ...p,
  }));

  // Track plugin IDs to avoid duplicates (official takes precedence)
  const seenIds = new Set(allPlugins.map((p) => p.id));

  // Fetch enabled custom registries in parallel
  const enabledCustom = customMarketplaces.filter((m) => m.enabled);
  const customResults = await Promise.allSettled(
    enabledCustom.map(async (m) => {
      const result = await fetchCustomRegistry(m);
      return { marketplace: m, ...result };
    }),
  );

  const custom: Array<{
    marketplace: CustomMarketplace;
    registry: MarketplaceRegistry;
    featured: MarketplaceFeatured | null;
    error?: string;
  }> = [];

  for (const result of customResults) {
    if (result.status === 'fulfilled') {
      const { marketplace, registry, featured } = result.value;
      custom.push({ marketplace, registry, featured });

      // Add non-duplicate plugins with source tags
      for (const plugin of registry.plugins) {
        if (!seenIds.has(plugin.id)) {
          seenIds.add(plugin.id);
          allPlugins.push({
            ...plugin,
            marketplaceId: marketplace.id,
            marketplaceName: marketplace.name,
          });
        }
      }
    } else {
      const marketplace = enabledCustom[customResults.indexOf(result)];
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      appLog('marketplace', 'warn', `Failed to fetch custom registry "${marketplace.name}": ${error}`);
      custom.push({
        marketplace,
        registry: { version: 1, updated: '', plugins: [] },
        featured: null,
        error,
      });
    }
  }

  return { official, custom, allPlugins };
}

export async function installPlugin(req: MarketplaceInstallRequest): Promise<MarketplaceInstallResult> {
  const { pluginId, assetUrl, sha256 } = req;

  appLog('marketplace', 'info', `Installing plugin: ${pluginId} from ${assetUrl}`);

  const pluginsDir = getCommunityPluginsDir();
  fs.mkdirSync(pluginsDir, { recursive: true });

  const pluginDir = path.join(pluginsDir, pluginId);
  const tmpZipPath = path.join(pluginsDir, `${pluginId}.tmp.zip`);

  try {
    // 1. Download the zip
    const res = await fetch(assetUrl);
    if (!res.ok) {
      return { success: false, error: `Download failed: ${res.status} ${res.statusText}` };
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    // 2. Verify SHA-256
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash !== sha256) {
      return { success: false, error: `Integrity check failed: expected ${sha256}, got ${hash}` };
    }

    // 3. Write zip to temp file
    fs.writeFileSync(tmpZipPath, buffer);

    // 4. Remove old version if present
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }

    // 5. Extract using adm-zip (cross-platform, no shell dependency)
    fs.mkdirSync(pluginDir, { recursive: true });
    const zip = new AdmZip(tmpZipPath);
    zip.extractAllTo(pluginDir, true);

    // 6. If the zip extracted into a single subdirectory, hoist its contents up
    const entries = fs.readdirSync(pluginDir);
    if (entries.length === 1) {
      const singleDir = path.join(pluginDir, entries[0]);
      if (fs.statSync(singleDir).isDirectory()) {
        const innerEntries = fs.readdirSync(singleDir);
        for (const e of innerEntries) {
          fs.renameSync(path.join(singleDir, e), path.join(pluginDir, e));
        }
        fs.rmdirSync(singleDir);
      }
    }

    // 7. Verify manifest.json exists
    if (!fs.existsSync(path.join(pluginDir, 'manifest.json'))) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      return { success: false, error: 'Downloaded plugin does not contain a manifest.json' };
    }

    // 8. Write .marketplace marker so the client knows this was installed from the marketplace
    fs.writeFileSync(path.join(pluginDir, '.marketplace'), '', 'utf-8');

    appLog('marketplace', 'info', `Plugin ${pluginId} installed successfully`);
    return { success: true };
  } catch (err: unknown) {
    // Clean up on failure
    if (fs.existsSync(pluginDir)) {
      try { fs.rmSync(pluginDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const message = err instanceof Error ? err.message : String(err);
    appLog('marketplace', 'error', `Failed to install ${pluginId}: ${message}`);
    return { success: false, error: message };
  } finally {
    // Clean up temp zip
    try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch { /* ignore */ }
  }
}
