import * as fsp from 'fs/promises';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { registerMcpCommand, toCommandId } from '../mcp-command-adapter';
import { discoverCommunityPlugins } from '../../plugin-discovery';
import { fetchAllRegistries, installPlugin as marketplaceInstallPlugin } from '../../marketplace-service';
import { listCustomMarketplaces } from '../../custom-marketplace-service';
import { SUPPORTED_PLUGIN_API_VERSIONS } from '../../../../shared/marketplace-types';
import { IPC } from '../../../../shared/ipc-channels';
import { requireString, optionalString, stringWithDefault, booleanWithDefault } from './validation';

/** Register plugin management and marketplace tools. */
export function registerPluginTools(): void {

// ── Plugin Tools ───────────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'list_plugins'),
  category: 'assistant',
  label: 'List Plugins',
  description:
    'List installed plugins with their name, description, version, and status. ' +
    'Shows both builtin and community (user-installed) plugins.',
  inputSchema: { type: 'object', properties: {} },
  targetKind: 'assistant',
  nameSuffix: 'list_plugins',
  handler: async () => {
  try {
    const discovered = await discoverCommunityPlugins();
    const plugins = discovered.map(p => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description || null,
      author: p.manifest.author || null,
      scope: p.manifest.scope,
      source: p.fromMarketplace ? 'marketplace' : 'community',
      path: p.pluginPath,
    }));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          pluginCount: plugins.length,
          plugins,
          note: 'Builtin plugins (canvas, browser, terminal, etc.) are always loaded and not listed here.',
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to list plugins: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'install_plugin'),
  category: 'assistant',
  label: 'Install Plugin',
  targetKind: 'assistant',
  nameSuffix: 'install_plugin',
  description:
    'Install a plugin from a local path. Copies the plugin directory to ~/.clubhouse/plugins/. ' +
    'IMPORTANT: This only installs the plugin — the user must enable it manually in Settings > Plugins. ' +
    'This is a security boundary: automated installation does not grant the plugin any permissions.',
  inputSchema: {
    type: 'object',
    properties: {
      source_path: {
        type: 'string',
        description: 'Absolute path to the plugin directory (must contain a manifest.json).',
      },
      plugin_id: {
        type: 'string',
        description: 'Optional plugin ID override. Defaults to the ID in manifest.json.',
      },
    },
    required: ['source_path'],
  },
  handler: async (_t, _a, args) => {
  const sourcePath = requireString(args, 'source_path').replace(/^~/, process.env.HOME || '/tmp');
  try {
    // Validate source path exists and has manifest.json
    const manifestPath = path.join(sourcePath, 'manifest.json');
    const manifestRaw = await fsp.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw);

    const pluginId = optionalString(args, 'plugin_id') || manifest.id;
    if (!pluginId) {
      return { content: [{ type: 'text', text: 'Plugin manifest.json must have an "id" field.' }], isError: true };
    }

    // Validate plugin ID is safe (no path traversal)
    if (pluginId.includes('/') || pluginId.includes('\\') || pluginId.includes('..') || pluginId.includes('\0')) {
      return { content: [{ type: 'text', text: `Invalid plugin ID: ${pluginId}` }], isError: true };
    }

    // Copy to ~/.clubhouse/plugins/<plugin_id>/
    const pluginsDir = path.join(app.getPath('home'), '.clubhouse', 'plugins');
    const destDir = path.join(pluginsDir, pluginId);

    await fsp.mkdir(pluginsDir, { recursive: true });
    await fsp.cp(sourcePath, destDir, { recursive: true });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          message: `Plugin "${manifest.name || pluginId}" installed successfully.`,
          id: pluginId,
          name: manifest.name || pluginId,
          version: manifest.version || 'unknown',
          installedTo: destDir,
          note: 'Plugin installed but NOT enabled. The user must enable it manually in Settings > Plugins.',
        }),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to install plugin: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  },
});

// ── Marketplace Tools ──────────────────────────────────────────────────────

registerMcpCommand({
  id: toCommandId('assistant', 'list_marketplace_plugins'),
  category: 'assistant',
  label: 'List Marketplace Plugins',
  targetKind: 'assistant',
  nameSuffix: 'list_marketplace_plugins',
  description:
    'List plugins available in the Clubhouse marketplace. Returns name, description, author, tags, ' +
    'latest version, permissions, and whether each plugin is already installed locally. ' +
    'Use this to help users discover plugins, answer "what plugins are available?", or suggest ' +
    'relevant plugins when a user describes a problem that a plugin could solve (e.g., scheduling → automation plugin, ' +
    'custom themes → theme plugin). Supports optional search to filter by name, description, author, or tags.',
  inputSchema: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Optional search query to filter plugins by name, description, author, or tags.',
      },
      tag: {
        type: 'string',
        description: 'Optional tag to filter plugins (e.g., "automation", "theme", "workflow").',
      },
      official_only: {
        type: 'boolean',
        description: 'If true, only return official plugins. Defaults to false.',
      },
    },
  },
  handler: async (_targetId, _agentId, args) => {
  try {
    const search = stringWithDefault(args, 'search', '').toLowerCase().trim();
    const tagFilter = stringWithDefault(args, 'tag', '').toLowerCase().trim();
    const officialOnly = booleanWithDefault(args, 'official_only', false);

    // Fetch registries (official + custom)
    const customMarketplaces = await listCustomMarketplaces();
    const { allPlugins } = await fetchAllRegistries(customMarketplaces);

    // Get installed plugins for comparison
    const installed = await discoverCommunityPlugins();
    const installedIds = new Set(installed.map(p => p.manifest.id));

    // Filter plugins
    let filtered = allPlugins;
    if (officialOnly) {
      filtered = filtered.filter(p => p.official);
    }
    if (tagFilter) {
      filtered = filtered.filter(p => p.tags.some(t => t.toLowerCase() === tagFilter));
    }
    if (search) {
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(search) ||
        p.description.toLowerCase().includes(search) ||
        p.author.toLowerCase().includes(search) ||
        p.tags.some(t => t.toLowerCase().includes(search)),
      );
    }

    const plugins = filtered.map(p => {
      const latestRelease = p.releases[p.latest];
      const compatible = latestRelease
        ? SUPPORTED_PLUGIN_API_VERSIONS.includes(latestRelease.api)
        : false;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        author: p.author,
        official: p.official,
        tags: p.tags,
        latest_version: p.latest,
        installed: installedIds.has(p.id),
        compatible,
        permissions: latestRelease?.permissions ?? [],
        size_bytes: latestRelease?.size ?? null,
        marketplace: p.marketplaceName ?? 'Official',
      };
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: plugins.length,
          plugins,
          hint: plugins.length === 0 && search
            ? `No plugins matched "${search}". Try a broader search or list all with no filters.`
            : 'To install a plugin, use the download_marketplace_plugin tool. Plugins must be enabled manually by the user in Settings > Plugins.',
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to fetch marketplace: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'download_marketplace_plugin'),
  category: 'assistant',
  label: 'Download Marketplace Plugin',
  targetKind: 'assistant',
  nameSuffix: 'download_marketplace_plugin',
  description:
    'Download and install a plugin from the Clubhouse marketplace. This downloads the plugin but does NOT ' +
    'enable it — the user must enable it manually in Settings > Plugins. This is a security boundary: ' +
    'automated installation does not grant the plugin any permissions. ' +
    'After downloading, always tell the user: 1) The plugin was downloaded successfully, ' +
    '2) They need to go to Settings > Plugins to enable it, and 3) Offer to open the plugin settings view for them.',
  inputSchema: {
    type: 'object',
    properties: {
      plugin_id: {
        type: 'string',
        description: 'The plugin ID from the marketplace (from list_marketplace_plugins).',
      },
      version: {
        type: 'string',
        description: 'Version to install. Defaults to the latest version.',
      },
    },
    required: ['plugin_id'],
  },
  handler: async (_targetId, _agentId, args) => {
  try {
    const pluginId = requireString(args, 'plugin_id');
    const requestedVersion = optionalString(args, 'version');

    // Fetch registry to get plugin details
    const customMarketplaces = await listCustomMarketplaces();
    const { allPlugins } = await fetchAllRegistries(customMarketplaces);

    const plugin = allPlugins.find(p => p.id === pluginId);
    if (!plugin) {
      return {
        content: [{ type: 'text', text: `Plugin "${pluginId}" not found in the marketplace. Use list_marketplace_plugins to see available plugins.` }],
        isError: true,
      };
    }

    const version = requestedVersion || plugin.latest;
    const release = plugin.releases[version];
    if (!release) {
      const available = Object.keys(plugin.releases).join(', ');
      return {
        content: [{ type: 'text', text: `Version "${version}" not found for plugin "${plugin.name}". Available versions: ${available}` }],
        isError: true,
      };
    }

    // Check API compatibility
    if (!SUPPORTED_PLUGIN_API_VERSIONS.includes(release.api)) {
      return {
        content: [{
          type: 'text',
          text: `Plugin "${plugin.name}" v${version} requires API version ${release.api}, which is not supported. ` +
            `Supported API versions: ${SUPPORTED_PLUGIN_API_VERSIONS.join(', ')}. The user may need to update Clubhouse.`,
        }],
        isError: true,
      };
    }

    // Check if already installed
    const installed = await discoverCommunityPlugins();
    const existing = installed.find(p => p.manifest.id === pluginId);
    if (existing) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            message: `Plugin "${plugin.name}" is already installed (version ${existing.manifest.version}).`,
            id: pluginId,
            installed_version: existing.manifest.version,
            latest_version: plugin.latest,
            note: existing.manifest.version !== plugin.latest
              ? 'A newer version is available. The user can update via Settings > Plugins.'
              : 'Already up to date.',
          }),
        }],
      };
    }

    // Download and install
    const result = await marketplaceInstallPlugin({
      pluginId,
      version,
      assetUrl: release.asset,
      sha256: release.sha256,
    });

    if (!result.success) {
      return {
        content: [{ type: 'text', text: `Failed to download plugin "${plugin.name}": ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          message: `Plugin "${plugin.name}" v${version} downloaded successfully.`,
          id: pluginId,
          name: plugin.name,
          version,
          permissions: release.permissions,
          note: 'Plugin downloaded but NOT enabled. The user must enable it manually in Settings > Plugins.',
          next_steps: [
            'Tell the user the plugin was downloaded successfully.',
            'Explain they need to go to Settings > Plugins to enable it.',
            'Offer to open the plugin settings view using the open_plugin_settings tool.',
          ],
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to download plugin: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  },
});

registerMcpCommand({
  id: toCommandId('assistant', 'open_plugin_settings'),
  category: 'assistant',
  label: 'Open Plugin Settings',
  targetKind: 'assistant',
  nameSuffix: 'open_plugin_settings',
  description:
    'Navigate the user to the Plugins settings view. Optionally opens the detail page for a specific plugin. ' +
    'Use this after downloading a plugin to help the user enable it, or when the user asks about plugin configuration.',
  inputSchema: {
    type: 'object',
    properties: {
      plugin_id: {
        type: 'string',
        description: 'Optional plugin ID to open its detail/settings page directly. If omitted, opens the plugin list.',
      },
    },
  },
  handler: async (_targetId, _agentId, args) => {
  const pluginId = optionalString(args, 'plugin_id');

  // Send navigation IPC to all windows
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.WINDOW.NAVIGATE_TO_PLUGIN_SETTINGS, pluginId);
  }

  return {
    content: [{
      type: 'text',
      text: pluginId
        ? `Opened plugin settings for "${pluginId}". The user can enable the plugin and review its permissions there.`
        : 'Opened the Plugins settings view. The user can browse, enable, and configure plugins there.',
    }],
  };
  },
});

}
