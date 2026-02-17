import * as fs from 'fs';
import * as path from 'path';
import { OrchestratorProvider } from '../orchestrators/types';
import { appLog } from './log-service';

interface FileSnapshot {
  originalContent: string | null; // null = file didn't exist before us
  refCount: number;
}

/** Keyed by absolute file path */
const snapshots = new Map<string, FileSnapshot>();
/** agentId → set of file paths this agent references */
const agentFiles = new Map<string, Set<string>>();

/**
 * Snapshot a config file before the first agent writes to it.
 * Increments refCount for subsequent agents referencing the same file.
 */
export function snapshotFile(agentId: string, filePath: string): void {
  const absPath = path.resolve(filePath);

  if (!snapshots.has(absPath)) {
    let originalContent: string | null = null;
    try {
      originalContent = fs.readFileSync(absPath, 'utf-8');
    } catch {
      // File doesn't exist yet — we'll delete it on restore
    }
    snapshots.set(absPath, { originalContent, refCount: 0 });
    appLog('core:config-pipeline', 'info', `Snapshot saved`, {
      meta: { filePath: absPath, existed: originalContent !== null },
    });
  }

  const snapshot = snapshots.get(absPath)!;
  snapshot.refCount++;

  let files = agentFiles.get(agentId);
  if (!files) {
    files = new Set();
    agentFiles.set(agentId, files);
  }
  files.add(absPath);
}

/**
 * Restore config files for a single agent.
 * Decrements refCount; when it hits 0, restores the original file.
 */
export function restoreForAgent(agentId: string): void {
  const files = agentFiles.get(agentId);
  if (!files) return;

  for (const absPath of files) {
    const snapshot = snapshots.get(absPath);
    if (!snapshot) continue;

    snapshot.refCount--;
    if (snapshot.refCount <= 0) {
      restoreSnapshot(absPath, snapshot);
      snapshots.delete(absPath);
    }
  }

  agentFiles.delete(agentId);
}

/**
 * Restore all snapshots immediately (for app quit).
 */
export function restoreAll(): void {
  for (const [absPath, snapshot] of snapshots) {
    restoreSnapshot(absPath, snapshot);
  }
  snapshots.clear();
  agentFiles.clear();
}

/**
 * Check if a file path is already being tracked.
 */
export function hasSnapshot(filePath: string): boolean {
  return snapshots.has(path.resolve(filePath));
}

/**
 * Resolve the hooks config file path for a provider in a given project directory.
 * Returns null if the provider doesn't support hooks.
 */
export function getHooksConfigPath(provider: OrchestratorProvider, cwd: string): string | null {
  if (!provider.getCapabilities().hooks) return null;
  return path.join(cwd, provider.conventions.configDir, provider.conventions.localSettingsFile);
}

/**
 * Check if a hook entry was written by Clubhouse.
 * Detects our entries by looking for the CLUBHOUSE_AGENT_ID env var
 * or the /hook/ URL pattern in command/bash strings.
 */
export function isClubhouseHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;

  // Claude Code format: { hooks: [{ type: 'command', command: '...' }] }
  if (Array.isArray(obj.hooks)) {
    return obj.hooks.some((h: unknown) => {
      if (!h || typeof h !== 'object') return false;
      const cmd = (h as Record<string, unknown>).command;
      return typeof cmd === 'string' && isClubhouseCommand(cmd);
    });
  }

  // Copilot format: { type: 'command', bash: '...' }
  if (typeof obj.bash === 'string') {
    return isClubhouseCommand(obj.bash);
  }

  // Also check direct command field (flat format)
  if (typeof obj.command === 'string') {
    return isClubhouseCommand(obj.command);
  }

  return false;
}

function isClubhouseCommand(cmd: string): boolean {
  return cmd.includes('CLUBHOUSE_AGENT_ID') || cmd.includes('/hook/');
}

function restoreSnapshot(absPath: string, snapshot: FileSnapshot): void {
  try {
    if (snapshot.originalContent === null) {
      // File didn't exist before — delete it
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        appLog('core:config-pipeline', 'info', `Restored (deleted)`, { meta: { filePath: absPath } });
      }
    } else {
      fs.writeFileSync(absPath, snapshot.originalContent, 'utf-8');
      appLog('core:config-pipeline', 'info', `Restored original`, { meta: { filePath: absPath } });
    }
  } catch (err) {
    appLog('core:config-pipeline', 'error', `Failed to restore`, {
      meta: { filePath: absPath, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** For testing: reset all internal state */
export function _resetForTesting(): void {
  snapshots.clear();
  agentFiles.clear();
}
