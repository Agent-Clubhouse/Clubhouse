import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
const picomatch = require('picomatch') as (
  patterns: string[],
  options?: { basename?: boolean }
) => (input: string) => boolean;
import type { FileSearchOptions, FileSearchResult, FileSearchFileResult, FileSearchMatch } from '../../shared/types';

const DEFAULT_MAX_RESULTS = 1_000;
const DEFAULT_CONTEXT_LINES = 0;
const MAX_LINE_CONTENT_LENGTH = 500;

/**
 * Try to locate the ripgrep binary. Returns the path or null if not found.
 */
function findRipgrep(): string | null {
  const candidates = [
    '/usr/local/bin/rg',
    '/opt/homebrew/bin/rg',
    '/usr/bin/rg',
  ];

  // Also try resolving 'rg' via `which`
  try {
    const resolved = execFileSync('which', ['rg'], {
      timeout: 3000,
      encoding: 'utf-8',
    }).trim();
    if (resolved && !candidates.includes(resolved)) {
      candidates.unshift(resolved);
    }
  } catch {
    // which not available or rg not found
  }

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], {
        timeout: 3000,
        stdio: 'ignore',
      });
      return candidate;
    } catch {
      // not found, try next
    }
  }
  return null;
}

let _rgPath: string | null | undefined;

function getRipgrepPath(): string | null {
  if (_rgPath === undefined) {
    _rgPath = findRipgrep();
  }
  return _rgPath;
}

/**
 * Search files in a directory using ripgrep for performance.
 */
export async function searchFiles(
  rootPath: string,
  query: string,
  options?: FileSearchOptions,
): Promise<FileSearchResult> {
  if (!query) {
    return { results: [], totalMatches: 0, truncated: false };
  }

  const rgPath = getRipgrepPath();
  if (rgPath) {
    return searchWithRipgrep(rgPath, rootPath, query, options);
  }
  return searchWithNodeFs(rootPath, query, options);
}

/**
 * Build ripgrep arguments from search options.
 */
function buildRgArgs(query: string, rootPath: string, options?: FileSearchOptions): string[] {
  const contextLines = options?.contextLines ?? DEFAULT_CONTEXT_LINES;

  const args: string[] = [
    '--json',                        // JSON output for structured parsing
    '--max-count', '100',            // max matches per file
    '--no-messages',                 // suppress file access error messages
  ];

  // Case sensitivity
  if (!options?.caseSensitive) {
    args.push('--ignore-case');
  } else {
    args.push('--case-sensitive');
  }

  // Whole word
  if (options?.wholeWord) {
    args.push('--word-regexp');
  }

  // Regex vs fixed string
  if (!options?.regex) {
    args.push('--fixed-strings');
  }

  // Context lines
  if (contextLines > 0) {
    args.push('--context', String(contextLines));
  }

  // Include globs
  if (options?.includeGlobs?.length) {
    for (const glob of options.includeGlobs) {
      args.push('--glob', glob);
    }
  }

  // Exclude globs
  if (options?.excludeGlobs?.length) {
    for (const glob of options.excludeGlobs) {
      args.push('--glob', `!${glob}`);
    }
  }

  // Always exclude common dirs
  args.push('--glob', '!.git/');

  // The search pattern and path
  args.push('--', query, rootPath);

  return args;
}

interface RgJsonMatch {
  type: string;
  data: {
    path?: { text: string };
    lines?: { text: string };
    line_number?: number;
    absolute_offset?: number;
    submatches?: Array<{
      match: { text: string };
      start: number;
      end: number;
    }>;
  };
}

function searchWithRipgrep(
  rgPath: string,
  rootPath: string,
  query: string,
  options?: FileSearchOptions,
): Promise<FileSearchResult> {
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const args = buildRgArgs(query, rootPath, options);

  return new Promise((resolve, reject) => {
    const child = execFile(
      rgPath,
      args,
      { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, _stderr) => {
        if (error) {
          // ripgrep exits with code 1 when no matches found — not an error
          const exitCode = (error as { code?: number }).code;
          if (exitCode === 1) {
            resolve({ results: [], totalMatches: 0, truncated: false });
            return;
          }
          reject(error);
          return;
        }

        try {
          const result = parseRipgrepOutput(stdout, rootPath, maxResults);
          resolve(result);
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );

    // Safety: kill if taking too long
    child.on('error', reject);
  });
}

function parseRipgrepOutput(
  stdout: string,
  rootPath: string,
  maxResults: number,
): FileSearchResult {
  const lines = stdout.split('\n').filter(Boolean);
  const fileMap = new Map<string, FileSearchMatch[]>();
  let totalMatches = 0;
  let truncated = false;

  for (const line of lines) {
    if (truncated) break;

    let parsed: RgJsonMatch;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== 'match') continue;

    const data = parsed.data;
    const filePath = data.path?.text;
    const lineContent = truncateLineContent(data.lines?.text?.replace(/\n$/, '') ?? '');
    const lineNumber = data.line_number ?? 0;

    if (!filePath) continue;

    // Compute relative path
    const relPath = filePath.startsWith(rootPath)
      ? filePath.slice(rootPath.length + 1)
      : filePath;

    if (!fileMap.has(relPath)) {
      fileMap.set(relPath, []);
    }

    const matches = fileMap.get(relPath)!;

    if (data.submatches) {
      for (const sub of data.submatches) {
        if (totalMatches >= maxResults) {
          truncated = true;
          break;
        }
        matches.push({
          line: lineNumber,
          column: sub.start + 1,
          length: sub.end - sub.start,
          lineContent,
        });
        totalMatches++;
      }
    } else {
      if (totalMatches >= maxResults) {
        truncated = true;
        break;
      }
      matches.push({
        line: lineNumber,
        column: 1,
        length: lineContent.trimEnd().length || 1,
        lineContent,
      });
      totalMatches++;
    }
  }

  const results: FileSearchFileResult[] = [];
  for (const [filePath, matches] of fileMap) {
    results.push({ filePath, matches });
  }

  return { results, totalMatches, truncated };
}

// ── Node.js fallback implementation ────────────────────────────────────

import * as fs from 'fs/promises';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.DS_Store', '.webpack', 'dist', '.next', '__pycache__',
]);

async function searchWithNodeFs(
  rootPath: string,
  query: string,
  options?: FileSearchOptions,
): Promise<FileSearchResult> {
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const caseSensitive = options?.caseSensitive ?? false;
  const wholeWord = options?.wholeWord ?? false;
  const useRegex = options?.regex ?? false;

  let pattern: RegExp;
  try {
    let src = useRegex ? query : escapeRegex(query);
    if (wholeWord) {
      src = `\\b${src}\\b`;
    }
    pattern = new RegExp(src, caseSensitive ? 'g' : 'gi');
  } catch {
    return { results: [], totalMatches: 0, truncated: false };
  }

  const files = await collectFiles(rootPath, options?.includeGlobs ?? undefined, options?.excludeGlobs ?? undefined);
  const results: FileSearchFileResult[] = [];
  let totalMatches = 0;
  let truncated = false;

  for (const filePath of files) {
    if (truncated) break;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const matches: FileSearchMatch[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (truncated) break;

        const line = lines[i];
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;

        while ((match = pattern.exec(line)) !== null) {
          if (totalMatches >= maxResults) {
            truncated = true;
            break;
          }
          matches.push({
            line: i + 1,
            column: match.index + 1,
            length: match[0].length,
            lineContent: truncateLineContent(line),
          });
          totalMatches++;

          // Prevent infinite loop on zero-length matches
          if (match[0].length === 0) {
            pattern.lastIndex++;
          }
        }
      }

      if (matches.length > 0) {
        const relPath = filePath.startsWith(rootPath)
          ? filePath.slice(rootPath.length + 1)
          : filePath;
        results.push({ filePath: relPath, matches });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { results, totalMatches, truncated };
}

function truncateLineContent(line: string): string {
  if (line.length <= MAX_LINE_CONTENT_LENGTH) return line;
  return line.slice(0, MAX_LINE_CONTENT_LENGTH) + '…';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flac', 'wav', 'ogg', 'webm',
  'pyc', 'class', 'o', 'obj',
  'sqlite', 'db',
]);

async function collectFiles(
  rootDir: string,
  includeGlobs?: string[],
  excludeGlobs?: string[],
): Promise<string[]> {
  const includeMatcher = includeGlobs?.length
    ? picomatch(includeGlobs, { basename: true })
    : null;
  const excludeMatcher = excludeGlobs?.length
    ? picomatch(excludeGlobs, { basename: true })
    : null;

  const collected: string[] = [];
  const maxFiles = 50_000;

  async function walk(dir: string): Promise<void> {
    if (collected.length >= maxFiles) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (collected.length >= maxFiles) break;
        if (IGNORED_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).slice(1).toLowerCase();
          if (BINARY_EXTENSIONS.has(ext)) continue;

          const relPath = fullPath.slice(rootDir.length + 1);

          // Apply include filter: if set, file must match
          if (includeMatcher && !includeMatcher(relPath)) continue;
          // Apply exclude filter: if set, file must not match
          if (excludeMatcher && excludeMatcher(relPath)) continue;

          collected.push(fullPath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  await walk(rootDir);
  return collected;
}
