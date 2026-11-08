import * as fsp from 'fs/promises';
import * as path from 'path';
import type { SettingsConventions } from './agent-settings-service';
import { appLog } from './log-service';

/**
 * Remove stale JSON content from TOML config files. Before TOML-aware guards
 * were added, Clubhouse could write JSON to .codex/config.toml, which Codex
 * CLI's TOML parser rejects with "invalid key-value pair, expected key".
 * agent-system runs this before every start of a TOML CLI.
 */
export async function cleanupStaleJsonInTomlConfigs(
  worktreePath: string,
  conv: SettingsConventions,
): Promise<void> {
  const filesToCheck = [
    path.join(worktreePath, conv.mcpConfigFile),
    path.join(worktreePath, conv.configDir, conv.localSettingsFile),
  ];

  // mcpConfigFile and configDir/localSettingsFile may be the same file.
  const uniquePaths = [...new Set(filesToCheck.map((p) => path.resolve(p)))];

  for (const filePath of uniquePaths) {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      // A JSON object: remove it so the CLI can start fresh. Not '[', since TOML section headers start with it.
      if (content.trimStart().startsWith('{')) {
        await fsp.unlink(filePath);
        appLog('core:materialization', 'info', 'Removed stale JSON content from TOML config file', {
          meta: { filePath },
        });
      }
    } catch {
      // telemetry-exempt: the file doesn't exist, so there is nothing to clean up
    }
  }
}
