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

/**
 * Lines of the `[mcp_servers.clubhouse]` section injectClubhouseMcp wrote
 * (mcpServerToToml's output, every version): `command = "node"`, one bridge
 * script in `args`, CLUBHOUSE_* names in `env_vars`, and CLUBHOUSE_* string
 * values in its `.env` subtable. There is no TOML parser here, so a section
 * matches only when every line is one of these exactly; anything else, a
 * comment or a key Clubhouse never wrote included, leaves the file alone.
 */
const BRIDGE_TABLE_LINE = [
  /^command = "node"$/,
  /^args = \["(?:[^"\\]|\\\\)*(?:\/|\\\\)clubhouse-mcp-bridge\.js"\]$/,
  /^env_vars = \["CLUBHOUSE_[A-Z_]+"(?:, "CLUBHOUSE_[A-Z_]+")*\]$/,
];
const BRIDGE_ENV_LINE = /^CLUBHOUSE_[A-Z_]+ = "[^"\\]*"$/;
const MAIN_HEADER = '[mcp_servers.clubhouse]';
const ENV_HEADER = '[mcp_servers.clubhouse.env]';

/**
 * Remove the `[mcp_servers.clubhouse]` section an older Clubhouse injected
 * into a TOML CLI's MCP config (#1728). Codex takes the bridge as launch
 * flags, and the file only made a `.codex` folder Codex asks the user to
 * trust. Only the section's own lines go, so the rest of the file keeps its
 * bytes; the file is deleted only when nothing else is left, and its folder
 * only when that leaves it empty. A file that can't be read, or whose
 * section isn't exactly what Clubhouse wrote, is left alone.
 */
export async function stripLegacyClubhouseBridgeToml(
  worktreePath: string,
  conv: SettingsConventions,
): Promise<boolean> {
  const filePath = path.join(worktreePath, conv.mcpConfigFile);
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch {
    // telemetry-exempt: no file means nothing an older Clubhouse left behind
    return false;
  }
  const stripped = withoutInjectedBridgeSection(content);
  if (stripped === null) return false;

  const empty = stripped.trim() === '';
  if (empty) {
    await fsp.unlink(filePath);
    try {
      // rmdir only removes an empty folder, so other config files stay.
      await fsp.rmdir(path.dirname(filePath));
    } catch {
      // telemetry-exempt: the folder holds other files, which stay
    }
  } else {
    await fsp.writeFile(filePath, stripped, 'utf-8');
  }
  appLog('core:materialization', 'info', 'Removed the Clubhouse MCP entry an older version wrote to a TOML config', {
    meta: { filePath, deleted: empty },
  });
  return true;
}

interface TomlLine {
  /** The table a `[header]` line opens, key parts unquoted and joined with dots (`[[array]]` tables keep their brackets). */
  header?: string;
  /** The dotted key a `key = value` line sets, unquoted. */
  key?: string;
}

/** Split a dotted TOML key into unquoted parts; null when it isn't one. */
function keyParts(text: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, i + 1);
      if (close < 0) return null;
      parts.push(text.slice(i + 1, close));
      i = close + 1;
    } else {
      const bareKey = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!bareKey) return null;
      parts.push(bareKey[0]);
      i += bareKey[0].length;
    }
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i < text.length) {
      if (text[i] !== '.') return null;
      i++;
      if (i >= text.length) return null;
    }
  }
  return parts.length > 0 ? parts : null;
}

const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')`;
const KEY_LINE = new RegExp(String.raw`^\s*(${KEY_PART}(?:\s*\.\s*${KEY_PART})*)\s*=`);

/**
 * Say which TOML lines open a table and which set a key, following strings
 * (multiline included), multiline arrays and comments, so a `[` inside a
 * string or an array isn't taken for a header. Null for text this can't
 * follow: an unterminated string, array or header, or a line that is none
 * of a header, a key, a comment or blank.
 */
function scanToml(lines: string[]): TomlLine[] | null {
  const out: TomlLine[] = [];
  let multiline: string | null = null;
  let depth = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const info: TomlLine = {};
    let i = 0;
    if (!multiline && depth === 0) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('[')) {
        const arrayTable = trimmed.startsWith('[[');
        const open = arrayTable ? 2 : 1;
        let j = open;
        let quote: string | null = null;
        for (; j < trimmed.length; j++) {
          const ch = trimmed[j];
          if (quote) {
            if (ch === quote) quote = null;
          } else if (ch === '"' || ch === "'") {
            quote = ch;
          } else if (ch === ']') {
            break;
          }
        }
        if (j >= trimmed.length || (arrayTable && trimmed[j + 1] !== ']')) return null;
        const parts = keyParts(trimmed.slice(open, j));
        if (!parts) return null;
        const rest = trimmed.slice(j + open).trim();
        if (rest && !rest.startsWith('#')) return null;
        info.header = arrayTable ? `[${parts.join('.')}]` : parts.join('.');
        out.push(info);
        continue;
      }
      const keyLine = KEY_LINE.exec(line);
      if (keyLine) {
        const parts = keyParts(keyLine[1]);
        if (!parts) return null;
        info.key = parts.join('.');
        i = keyLine[0].length;
      } else if (trimmed && !trimmed.startsWith('#')) {
        return null;
      }
    }
    while (i < line.length) {
      if (multiline) {
        if (multiline === '"""' && line[i] === '\\') { i += 2; continue; }
        if (line.startsWith(multiline, i)) {
          i += 3;
          // Up to two more quotes can end the string's content.
          while (line[i] === multiline[0]) i++;
          multiline = null;
          continue;
        }
        i++;
        continue;
      }
      const ch = line[i];
      if (ch === '#') break;
      const triple = line.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        multiline = triple;
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        for (; j < line.length; j++) {
          if (ch === '"' && line[j] === '\\') { j++; continue; }
          if (line[j] === ch) break;
        }
        if (j >= line.length) return null;
        i = j + 1;
        continue;
      }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth < 0) return null;
      }
      i++;
    }
    out.push(info);
  }
  if (multiline || depth !== 0) return null;
  return out;
}

const BRIDGE_TABLE = 'mcp_servers.clubhouse';

/** Whether a table or key path is the bridge's table or inside it. */
const inBridgeTable = (name: string) => name === BRIDGE_TABLE || name.startsWith(`${BRIDGE_TABLE}.`);

/**
 * The text without Clubhouse's injected bridge section, or null when there is
 * none to remove, the section isn't exactly what Clubhouse wrote, or the TOML
 * can't be followed. Only the section's lines go; every other byte stays.
 */
export function withoutInjectedBridgeSection(toml: string): string | null {
  const lines = toml.split('\n');
  const scanned = scanToml(lines);
  if (!scanned) return null;
  const bare = (i: number) => lines[i].replace(/\r$/, '').trimEnd();

  // Exactly one bridge table, with the header as Clubhouse wrote it.
  const opens = scanned.flatMap((line, i) => (line.header === BRIDGE_TABLE ? [i] : []));
  if (opens.length !== 1 || bare(opens[0]) !== MAIN_HEADER) return null;
  const start = opens[0];

  // The section runs to the next header, through Clubhouse's `.env` subtable.
  // The empty piece after a final newline isn't the section's: keep that newline.
  const last = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  let end = start + 1;
  let inEnv = false;
  const seen = new Set<number>();
  for (; end < last; end++) {
    const { header } = scanned[end];
    const line = bare(end);
    if (header !== undefined) {
      if (header !== `${BRIDGE_TABLE}.env` || inEnv) break;
      if (line !== ENV_HEADER) return null;
      inEnv = true;
      continue;
    }
    if (line === '') continue;
    if (inEnv) {
      if (!BRIDGE_ENV_LINE.test(line)) return null;
      continue;
    }
    const kind = BRIDGE_TABLE_LINE.findIndex((re) => re.test(line));
    if (kind < 0 || seen.has(kind)) return null;
    seen.add(kind);
  }
  // command and args are what make it the bridge.
  if (!seen.has(0) || !seen.has(1)) return null;

  // Nothing else may add to the bridge's table: another header or a dotted key.
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    if (i >= start && i < end) continue;
    const { header, key } = scanned[i];
    if (header !== undefined) {
      table = header.replace(/^\[(.*)\]$/, '$1');
      if (inBridgeTable(table)) return null;
    } else if (key !== undefined && inBridgeTable(table ? `${table}.${key}` : key)) {
      return null;
    }
  }

  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}
