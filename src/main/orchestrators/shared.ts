import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { app } from 'electron';
import { getShellEnvironment } from '../util/shell';

/**
 * Shared binary finder used by all orchestrator providers.
 *
 * On Windows the most reliable check is `where` — it resolves the binary
 * exactly the way cmd.exe does (honoring PATH, PATHEXT, App Paths, etc.).
 * We try that first, then fall back to a manual PATH scan and finally
 * provider-supplied extra paths.
 *
 * On macOS/Linux we source the user's login shell to get the full PATH
 * (packaged Electron apps launched from the Dock only see a minimal PATH),
 * then check extra paths.
 */
export function findBinaryInPath(names: string[], extraPaths: string[]): string {
  const isWin = process.platform === 'win32';

  // ── 1. Shell-native lookup (`where` / `which`) — most authoritative ──
  for (const name of names) {
    try {
      if (isWin) {
        const result = execSync(`where ${name}`, {
          encoding: 'utf-8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'], // suppress "INFO: Could not find files" on stderr
        }).trim().split(/\r?\n/)[0].trim();
        if (result && fs.existsSync(result)) return result;
      } else {
        const shell = process.env.SHELL || '/bin/zsh';
        const result = execSync(`${shell} -ilc 'which ${name}'`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
        if (result && fs.existsSync(result)) return result;
      }
    } catch {
      // not on PATH — continue to manual search
    }
  }

  // ── 2. Manual PATH scan ──
  // getShellEnvironment() spreads process.env into a plain object which loses
  // Windows' case-insensitive key access (actual key is "Path", not "PATH").
  // Try the shell env first (works on Unix and in tests), fall back to the
  // case-insensitive process.env.PATH accessor which always works on Windows.
  const shellEnv = getShellEnvironment();
  const shellPATH = shellEnv.PATH || process.env.PATH || '';
  for (const dir of shellPATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
      if (isWin) {
        for (const ext of ['.exe', '.cmd', '.ps1']) {
          const withExt = candidate + ext;
          if (fs.existsSync(withExt)) return withExt;
        }
      }
    }
  }

  // ── 3. Provider-supplied well-known paths (fallback) ──
  for (const p of extraPaths) {
    if (fs.existsSync(p)) return p;
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
