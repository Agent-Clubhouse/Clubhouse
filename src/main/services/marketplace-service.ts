import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import AdmZip from 'adm-zip';
import { appLog } from './log-service';
import { createSettingsStore } from './settings-store';
import type { MarketplaceSettings } from '../../shared/types';
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
import { isValidPluginId } from '../../shared/manifest-validator';

const REGISTRY_URL =
  'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse-Workshop/main/registry/registry.json';
const FEATURED_URL =
  'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse-Workshop/main/registry/featured.json';
export const PREVIEW_REGISTRY_URL =
  'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse-Workshop/main/registry/preview-registry.json';

const marketplaceSettingsStore = createSettingsStore<MarketplaceSettings>('marketplace-settings.json', {
  showBetaPlugins: false,
});

export const getMarketplaceSettings = marketplaceSettingsStore.get;
export const saveMarketplaceSettings = marketplaceSettingsStore.save;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 30_000; // 30 seconds for registry/metadata fetches
const DOWNLOAD_TIMEOUT_MS = 60_000; // 60 seconds for plugin zip downloads

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

  const registryRes = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!registryRes.ok) {
    throw new Error(`Failed to fetch registry: ${registryRes.status} ${registryRes.statusText}`);
  }
  const registry: MarketplaceRegistry = await registryRes.json();

  let featured: MarketplaceFeatured | null = null;
  try {
    const featuredRes = await fetch(FEATURED_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

  const registryRes = await fetch(marketplace.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
    const featuredRes = await fetch(featuredUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

/**
 * Resolve the install directory for `pluginId`, refusing anything that is not
 * a valid plugin id or would not land directly inside `pluginsDir`.
 */
function resolvePluginInstallDir(pluginsDir: string, pluginId: string): string {
  if (!isValidPluginId(pluginId)) {
    throw new Error(`Invalid plugin id: ${JSON.stringify(pluginId)}`);
  }
  const root = path.resolve(pluginsDir);
  const pluginDir = path.resolve(root, pluginId);
  if (path.dirname(pluginDir) !== root) {
    throw new Error(`Plugin path escapes plugins directory: ${pluginId}`);
  }
  return pluginDir;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

export async function installPlugin(req: MarketplaceInstallRequest): Promise<MarketplaceInstallResult> {
  const { pluginId, assetUrl, sha256 } = req;

  const pluginsDir = getCommunityPluginsDir();
  let pluginDir: string;
  try {
    pluginDir = resolvePluginInstallDir(pluginsDir, pluginId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    appLog('marketplace', 'error', `Refusing to install plugin: ${message}`);
    return { success: false, error: message };
  }

  appLog('marketplace', 'info', `Installing plugin: ${pluginId} from ${assetUrl}`);

  // Everything is downloaded, extracted and validated in a fresh staging
  // directory. It lives beside (not inside) the plugins root so plugin
  // discovery never sees a half-installed plugin, and on the same volume so
  // the final swap is a rename. Failure cleanup only ever removes this
  // staging directory — the existing install is untouched until the new one
  // is fully validated.
  const stagingRoot = path.join(path.dirname(pluginsDir), '.plugin-staging');
  await fsp.mkdir(pluginsDir, { recursive: true });
  await fsp.mkdir(stagingRoot, { recursive: true });
  const stagingDir = await fsp.mkdtemp(path.join(stagingRoot, `${pluginId}-`));
  const tmpZipPath = path.join(stagingDir, `${pluginId}.tmp.zip`);
  const extractDir = path.join(stagingDir, 'plugin');
  const backupDir = path.join(stagingDir, 'previous');
  let preserveStaging = false;

  try {
    // 1. Download the zip
    const res = await fetch(assetUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      return { success: false, error: `Download failed: ${res.status} ${res.statusText}` };
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    // 2. Verify SHA-256
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash !== sha256) {
      return { success: false, error: `Integrity check failed: expected ${sha256}, got ${hash}` };
    }

    // 3. Write zip to the staging directory
    await fsp.writeFile(tmpZipPath, buffer);

    // 4. Extract using adm-zip (cross-platform, no shell dependency)
    await fsp.mkdir(extractDir, { recursive: true });
    const zip = new AdmZip(tmpZipPath);
    zip.extractAllTo(extractDir, true);

    // 5. If the zip extracted into a single subdirectory, hoist its contents up
    const entries = await fsp.readdir(extractDir);
    if (entries.length === 1) {
      const singleDir = path.join(extractDir, entries[0]);
      const singleStat = await fsp.stat(singleDir);
      if (singleStat.isDirectory()) {
        const innerEntries = await fsp.readdir(singleDir);
        for (const e of innerEntries) {
          await fsp.rename(path.join(singleDir, e), path.join(extractDir, e));
        }
        await fsp.rmdir(singleDir);
      }
    }

    // 6. Verify manifest.json exists
    try {
      await fsp.access(path.join(extractDir, 'manifest.json'));
    } catch {
      return { success: false, error: 'Downloaded plugin does not contain a manifest.json' };
    }

    // 7. Write .marketplace marker so the client knows this was installed from the marketplace
    await fsp.writeFile(path.join(extractDir, '.marketplace'), '', 'utf-8');

    // 8. Swap into place: move the old install aside, move the new one in,
    //    and restore the old one if the second move fails.
    let hadPrevious = false;
    try {
      await fsp.rename(pluginDir, backupDir);
      hadPrevious = true;
    } catch (err: unknown) {
      if (!isErrnoCode(err, 'ENOENT')) throw err;
    }
    try {
      await fsp.rename(extractDir, pluginDir);
    } catch (err: unknown) {
      if (hadPrevious) {
        try {
          await fsp.rename(backupDir, pluginDir);
        } catch (restoreErr: unknown) {
          const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          appLog('marketplace', 'error', `Failed to restore previous install of ${pluginId} from ${backupDir}: ${restoreMsg}`);
          // Leave the staging directory (and the backup in it) for manual recovery.
          preserveStaging = true;
        }
      }
      throw err;
    }

    appLog('marketplace', 'info', `Plugin ${pluginId} installed successfully`);
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    appLog('marketplace', 'error', `Failed to install ${pluginId}: ${message}`);
    return { success: false, error: message };
  } finally {
    // Clean up the staging directory (temp zip, failed extraction, or the
    // superseded previous install after a successful swap).
    if (!preserveStaging) {
      try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
