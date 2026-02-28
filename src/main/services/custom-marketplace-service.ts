import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { appLog } from './log-service';
import type {
  CustomMarketplace,
  CustomMarketplaceAddRequest,
  CustomMarketplaceRemoveRequest,
  CustomMarketplaceToggleRequest,
} from '../../shared/marketplace-types';

/**
 * Custom marketplace list is persisted at:
 *   ~/.clubhouse/plugin-data/_system/kv/custom-marketplaces.json
 *
 * This mirrors the pattern used for plugin enabled lists and settings.
 */

function getStoragePath(): string {
  return path.join(
    app.getPath('home'),
    '.clubhouse',
    'plugin-data',
    '_system',
    'kv',
    'custom-marketplaces.json',
  );
}

function readMarketplaces(): CustomMarketplace[] {
  const filePath = getStoragePath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
  } catch {
    appLog('marketplace:custom', 'warn', 'Failed to read custom marketplaces');
    return [];
  }
}

function writeMarketplaces(marketplaces: CustomMarketplace[]): void {
  const filePath = getStoragePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(marketplaces, null, 2), 'utf-8');
}

function generateId(): string {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUrl(url: string): string {
  let u = url.trim();
  // Ensure URL ends with registry.json if it doesn't already
  if (!u.endsWith('.json')) {
    u = u.replace(/\/$/, '') + '/registry.json';
  }
  return u;
}

export function listCustomMarketplaces(): CustomMarketplace[] {
  return readMarketplaces();
}

export function addCustomMarketplace(req: CustomMarketplaceAddRequest): CustomMarketplace {
  const marketplaces = readMarketplaces();

  const normalizedUrl = normalizeUrl(req.url);

  // Check for duplicate URL
  const existing = marketplaces.find((m) => m.url === normalizedUrl);
  if (existing) {
    throw new Error(`A custom marketplace with this URL already exists: "${existing.name}"`);
  }

  const marketplace: CustomMarketplace = {
    id: generateId(),
    name: req.name.trim(),
    url: normalizedUrl,
    enabled: true,
  };

  marketplaces.push(marketplace);
  writeMarketplaces(marketplaces);

  appLog('marketplace:custom', 'info', `Added custom marketplace: ${marketplace.name} (${marketplace.url})`);
  return marketplace;
}

export function removeCustomMarketplace(req: CustomMarketplaceRemoveRequest): void {
  const marketplaces = readMarketplaces();
  const idx = marketplaces.findIndex((m) => m.id === req.id);
  if (idx === -1) {
    throw new Error(`Custom marketplace not found: ${req.id}`);
  }

  const removed = marketplaces.splice(idx, 1)[0];
  writeMarketplaces(marketplaces);

  appLog('marketplace:custom', 'info', `Removed custom marketplace: ${removed.name}`);
}

export function toggleCustomMarketplace(req: CustomMarketplaceToggleRequest): CustomMarketplace {
  const marketplaces = readMarketplaces();
  const marketplace = marketplaces.find((m) => m.id === req.id);
  if (!marketplace) {
    throw new Error(`Custom marketplace not found: ${req.id}`);
  }

  marketplace.enabled = req.enabled;
  writeMarketplaces(marketplaces);

  appLog('marketplace:custom', 'info', `${req.enabled ? 'Enabled' : 'Disabled'} custom marketplace: ${marketplace.name}`);
  return marketplace;
}
