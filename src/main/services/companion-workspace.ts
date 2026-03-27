/**
 * Companion Workspace Service — manages plugin-owned companion workspaces.
 *
 * Each workspace plugin gets a persistent, git-tracked directory at:
 *   ~/.clubhouse/plugin-workspaces/<pluginId>/
 *
 * The workspace is created on first activation and survives plugin updates.
 * It is deleted only on explicit plugin uninstall (with confirmation).
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { appLog } from './log-service';

const execAsync = promisify(exec);

/** Root directory for all companion workspaces. */
function getWorkspacesRoot(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'plugin-workspaces');
}

/** Get the workspace path for a specific plugin. */
export function getCompanionWorkspacePath(pluginId: string): string {
  return path.join(getWorkspacesRoot(), pluginId);
}

/** Check if a companion workspace exists for a plugin. */
export async function workspaceExists(pluginId: string): Promise<boolean> {
  try {
    await fs.access(getCompanionWorkspacePath(pluginId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a companion workspace exists for a plugin.
 * Creates the directory and initializes a git repo if it doesn't exist.
 * Returns the workspace path.
 */
export async function ensureCompanionWorkspace(pluginId: string): Promise<string> {
  const wsPath = getCompanionWorkspacePath(pluginId);
  const exists = await workspaceExists(pluginId);

  if (exists) {
    appLog('core:companion', 'info', `Companion workspace already exists for ${pluginId}`, {
      meta: { pluginId, path: wsPath },
    });
    return wsPath;
  }

  appLog('core:companion', 'info', `Creating companion workspace for ${pluginId}`, {
    meta: { pluginId, path: wsPath },
  });

  // Create directory
  await fs.mkdir(wsPath, { recursive: true });

  // Initialize git repo
  try {
    await execAsync('git init', { cwd: wsPath });
    await execAsync('git commit --allow-empty -m "Initialize companion workspace"', { cwd: wsPath });
    appLog('core:companion', 'info', `Git initialized for companion workspace ${pluginId}`);
  } catch (err) {
    appLog('core:companion', 'warn', `Failed to initialize git for companion workspace ${pluginId}`, {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    // Non-fatal — workspace is still usable without git
  }

  return wsPath;
}

/**
 * Remove a companion workspace. Called on plugin uninstall.
 * Returns true if the workspace was deleted, false if it didn't exist.
 */
export async function removeCompanionWorkspace(pluginId: string): Promise<boolean> {
  const wsPath = getCompanionWorkspacePath(pluginId);
  const exists = await workspaceExists(pluginId);

  if (!exists) {
    return false;
  }

  appLog('core:companion', 'info', `Removing companion workspace for ${pluginId}`, {
    meta: { pluginId, path: wsPath },
  });

  await fs.rm(wsPath, { recursive: true, force: true });
  return true;
}
