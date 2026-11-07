/**
 * The agent's own MCP file, kept before Clubhouse first writes its managed
 * one (#2893). It stays inside the agent's folder, out of commits, so any
 * values in it never reach Clubhouse storage (D54).
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { OrchestratorConventions } from '../../orchestrators/types';

/** In the agent's folder; git-excluded with the other managed files. */
export const MCP_BACKUP_DIR = '.clubhouse-before-managed';

/** Where the MCP file is kept, relative to the agent's folder, with forward slashes. */
export function mcpBackupPath(conv: Pick<OrchestratorConventions, 'mcpConfigFile'>): string {
  return `${MCP_BACKUP_DIR}/${conv.mcpConfigFile.replace(/\\/g, '/')}`;
}

/** Whether the agent has an MCP file a managed start would overwrite. TOML CLIs get their servers as launch flags, so theirs is never written. */
export async function hasMcpFileToKeep(worktree: string, conv: Pick<OrchestratorConventions, 'mcpConfigFile' | 'settingsFormat'>): Promise<boolean> {
  if (conv.settingsFormat === 'toml' || !conv.mcpConfigFile) return false;
  try {
    return (await fsp.stat(path.join(worktree, conv.mcpConfigFile))).isFile();
  } catch {
    // telemetry-exempt: no MCP file, so nothing to keep
    return false;
  }
}

/**
 * Copy the MCP file aside. An earlier copy is never overwritten: a second
 * one gets a time suffix. Returns the copy's path relative to the folder, or
 * null when there was nothing to keep.
 */
export async function backupMcpFile(worktree: string, conv: Pick<OrchestratorConventions, 'mcpConfigFile' | 'settingsFormat'>): Promise<string | null> {
  if (!(await hasMcpFileToKeep(worktree, conv))) return null;
  let rel = mcpBackupPath(conv);
  try {
    await fsp.stat(path.join(worktree, rel));
    rel = `${rel}.${Date.now()}`;
  } catch { /* telemetry-exempt: no earlier copy */ }
  const target = path.join(worktree, rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(path.join(worktree, conv.mcpConfigFile), target);
  return rel;
}
