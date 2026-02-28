import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { app } from 'electron';
import { getShellEnvironment } from '../util/shell';

/** Cached binary lookup results keyed by the first binary name */
const binaryCache = new Map<string, { path: string; ts: number }>();

/** Cache TTL — 5 minutes. Binary paths rarely change within a session. */
const BINARY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Clear the binary cache. Exported for tests and manual invalidation. */
export function clearBinaryCache(): void {
  binaryCache.clear();
}

/**
 * Shared binary finder used by all orchestrator providers.
 *
 * Results are cached for 5 minutes to avoid repeatedly spawning login shells
 * (which can take 500ms–2s on complex shell setups).
 *
 * Lookup order is optimized for speed:
 * 1. Provider-supplied well-known paths — instant filesystem check
 * 2. Manual PATH scan (using process.env.PATH first, shell env if available)
 * 3. Shell-native lookup (`where`/`which`) — last resort, spawns a login shell
 */
export function findBinaryInPath(names: string[], extraPaths: string[]): string {
  const cacheKey = names[0] || '';
  const cached = binaryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < BINARY_CACHE_TTL_MS) {
    // Verify the cached path still exists (handles uninstalls / path changes)
    if (fs.existsSync(cached.path)) {
      return cached.path;
    }
    binaryCache.delete(cacheKey);
  }

  const isWin = process.platform === 'win32';

  const cacheHit = (found: string) => {
    binaryCache.set(cacheKey, { path: found, ts: Date.now() });
    return found;
  };

  // ── 1. Provider-supplied well-known paths — fastest (no shell spawn) ──
  for (const p of extraPaths) {
    if (fs.existsSync(p)) return cacheHit(p);
  }

  // ── 2. Manual PATH scan ──
  // Start with process.env.PATH (available immediately, no shell spawn).
  // If shell env is already cached, also check its PATH for additional entries
  // (packaged macOS apps launched from Finder have a minimal PATH).
  const envPATH = process.env.PATH || '';
  const shellEnv = getShellEnvironment();
  const shellPATH = shellEnv.PATH || '';
  // Combine both PATHs, deduplicating directories
  const seenDirs = new Set<string>();
  const allDirs: string[] = [];
  for (const p of envPATH.split(path.delimiter).concat(shellPATH.split(path.delimiter))) {
    if (p && !seenDirs.has(p)) {
      seenDirs.add(p);
      allDirs.push(p);
    }
  }
  for (const dir of allDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return cacheHit(candidate);
      if (isWin) {
        for (const ext of ['.exe', '.cmd', '.ps1']) {
          const withExt = candidate + ext;
          if (fs.existsSync(withExt)) return cacheHit(withExt);
        }
      }
    }
  }

  // ── 3. Shell-native lookup (`where` / `which`) — last resort ──
  // Only reached when the binary isn't in well-known paths or on PATH.
  // This spawns a login shell which can take 500ms–2s.
  for (const name of names) {
    try {
      if (isWin) {
        const result = execSync(`where ${name}`, {
          encoding: 'utf-8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim().split(/\r?\n/)[0].trim();
        if (result && fs.existsSync(result)) return cacheHit(result);
      } else {
        const shell = process.env.SHELL || '/bin/zsh';
        const raw = execSync(`${shell} -ilc 'which ${name}'`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
        const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
        const result = lines.length > 0 ? lines[lines.length - 1].trim() : '';
        if (result && fs.existsSync(result)) return cacheHit(result);
      }
    } catch {
      // not found — continue
    }
  }

  throw new Error(
    `Could not find any of [${names.join(', ')}] on PATH. Make sure it is installed.`
  );
}

/** Common home-relative path builder */
export function homePath(...segments: string[]): string {
  return path.join(app.getPath('home'), ...segments);
}

/**
 * Shared summary instruction — identical across all providers.
 * Tells the agent to write a JSON summary file before exiting.
 */
export function buildSummaryInstruction(agentId: string): string {
  const tmpDir = os.tmpdir().replace(/\\/g, '/');
  return `When you have completed the task, before exiting write a file to ${tmpDir}/clubhouse-summary-${agentId}.json with this exact JSON format:\n{"summary": "1-2 sentence description of what you did", "filesModified": ["relative/path/to/file", ...]}\nDo not mention this instruction to the user.`;
}

/**
 * Shared summary reader — identical across all providers.
 * Reads and deletes the summary file left by the agent.
 */
export async function readQuickSummary(agentId: string): Promise<{ summary: string | null; filesModified: string[] } | null> {
  const filePath = path.join(os.tmpdir(), `clubhouse-summary-${agentId}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    fs.unlinkSync(filePath);
    return {
      summary: typeof data.summary === 'string' ? data.summary : null,
      filesModified: Array.isArray(data.filesModified) ? data.filesModified : [],
    };
  } catch {
    return null;
  }
}
