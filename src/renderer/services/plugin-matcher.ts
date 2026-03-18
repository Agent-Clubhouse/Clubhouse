/**
 * Plugin Matcher Service (#868)
 *
 * Compares a satellite's plugins against locally installed plugins.
 * Exact `{ id, version }` match is required for compatibility.
 */

export interface PluginInfo {
  id: string;
  version: string;
  name?: string;
}

export type PluginMatchStatus = 'matched' | 'missing' | 'version_mismatch';

export interface PluginMatchResult {
  id: string;
  name: string;
  status: PluginMatchStatus;
  localVersion?: string;
  remoteVersion: string;
}

/**
 * Match satellite plugins against local plugins.
 *
 * @param satellitePlugins - Plugins reported by the satellite snapshot
 * @param localPlugins - Locally installed plugins
 * @returns Array of match results for each satellite plugin
 */
export function matchPlugins(
  satellitePlugins: PluginInfo[],
  localPlugins: PluginInfo[],
): PluginMatchResult[] {
  const localMap = new Map<string, PluginInfo>();
  for (const p of localPlugins) {
    localMap.set(p.id, p);
  }

  return satellitePlugins.map((remote) => {
    const local = localMap.get(remote.id);

    if (!local) {
      return {
        id: remote.id,
        name: remote.name || remote.id,
        status: 'missing' as const,
        remoteVersion: remote.version,
      };
    }

    if (local.version !== remote.version) {
      return {
        id: remote.id,
        name: remote.name || remote.id,
        status: 'version_mismatch' as const,
        localVersion: local.version,
        remoteVersion: remote.version,
      };
    }

    return {
      id: remote.id,
      name: remote.name || remote.id,
      status: 'matched' as const,
      localVersion: local.version,
      remoteVersion: remote.version,
    };
  });
}
