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
} from '../../shared/marketplace-types';

const REGISTRY_URL =
  'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse-Workshop/main/registry/registry.json';
const FEATURED_URL =
  'https://raw.githubusercontent.com/Agent-Clubhouse/Clubhouse-Workshop/main/registry/featured.json';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let registryCache: { data: MarketplaceFetchResult; fetchedAt: number } | null = null;

/** @internal Reset cache — exported for tests only. */
export function _resetCache(): void {
  registryCache = null;
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
