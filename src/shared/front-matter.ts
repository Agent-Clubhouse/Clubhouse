import { normalizeOrchestrationConfig } from './orchestration-policy';

/**
 * Front matter at the top of a Markdown file: `key: <value>` lines between
 * `---` fences, where `<value>` is JSON when it parses and a raw string
 * otherwise (so a hand-edited `model: claude-opus-4-8` reads too).
 *
 * Clubhouse no longer writes it: it was how persona files carried launch
 * settings and orchestration defaults, and personas were retired (#2901). It
 * is still read for two things: a block's text is refused when it carries
 * launch settings (asset-catalog validation), and the switch to managed reads
 * a legacy persona file's orchestration defaults
 * (managed-agents/legacy-migration).
 */
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)+/;

/** The launch settings a persona file could carry, which a block must not. */
const LAUNCH_SETTING_KEYS: ReadonlySet<string> = new Set([
  'model',
  'orchestrator',
  'mcpIds',
  'mcpConfigs',
  'freeAgentMode',
  'mission',
  'buildCommand',
  'testCommand',
  'lintCommand',
  'sourceControlProvider',
  'skills',
]);

/** Each `key: value` line of the front matter, in order, or null when there is none. Empty values are left out. */
function frontMatterEntries(raw: string): Array<[string, unknown]> | null {
  const match = raw.match(FRONT_MATTER_RE);
  if (!match) return null;
  const entries: Array<[string, unknown]> = [];
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const rawValue = trimmed.slice(idx + 1).trim();
    if (rawValue === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      // Tolerate unquoted scalar strings.
      value = rawValue;
    }
    entries.push([trimmed.slice(0, idx).trim(), value]);
  }
  return entries;
}

/**
 * The launch settings the front matter sets, by key: the old persona settings
 * and `orchestration` when it holds a valid field. Empty without front matter.
 */
export function frontMatterLaunchSettings(raw: string): string[] {
  const keys = new Set<string>();
  for (const [key, value] of frontMatterEntries(raw) ?? []) {
    if (LAUNCH_SETTING_KEYS.has(key)) keys.add(key);
    else if (key === 'orchestration' && normalizeOrchestrationConfig(value)) keys.add(key);
  }
  return [...keys];
}

/**
 * Read one front-matter value by key, parsed as JSON when possible. Returns
 * undefined when the file has no front matter or no such key. The first line
 * with the key wins.
 */
export function readFrontMatterValue(raw: string, key: string): unknown {
  return frontMatterEntries(raw)?.find(([k]) => k === key)?.[1];
}

/** The Markdown after the front matter, or the whole text when there is none. */
export function stripFrontMatter(raw: string): string {
  const match = raw.match(FRONT_MATTER_RE);
  return match ? raw.slice(match[0].length) : raw;
}
