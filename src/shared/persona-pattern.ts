import { SourceControlProvider } from './types';

/**
 * The reusable agent-settings bundle a persona "pattern" can carry, stored as
 * YAML front-matter at the top of a persona .md file. Every field is optional;
 * only the ones present are applied when the persona is applied to an agent.
 *
 * These keys mirror the per-agent overrides on DurableConfigUpdates so a pattern
 * applies cleanly via updateDurableConfig.
 */
export interface PatternSettings {
  model?: string;
  orchestrator?: string;
  mcpIds?: string[];
  mcpConfigs?: Record<string, Record<string, string>>;
  freeAgentMode?: boolean;
  structuredMode?: boolean;
  mission?: string;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  sourceControlProvider?: SourceControlProvider;
}

/** Ordered list of the keys a pattern may carry (used by extract UI + apply). */
export const PATTERN_SETTING_KEYS: Array<keyof PatternSettings> = [
  'model',
  'orchestrator',
  'mcpIds',
  'mcpConfigs',
  'freeAgentMode',
  'structuredMode',
  'mission',
  'buildCommand',
  'testCommand',
  'lintCommand',
  'sourceControlProvider',
];

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)+/;

/**
 * Split a persona file into its YAML front-matter settings and markdown body.
 * Front-matter lines are `key: <value>`, where `<value>` is JSON when possible
 * (so arrays/objects round-trip exactly) and otherwise treated as a raw string
 * (tolerates hand-edited unquoted scalars like `model: claude-opus-4-8`).
 * Files without front-matter parse to `{ settings: {}, body: <whole file> }`.
 */
export function parsePersonaFile(raw: string): { settings: PatternSettings; body: string } {
  const match = raw.match(FRONT_MATTER_RE);
  if (!match) return { settings: {}, body: raw };

  const body = raw.slice(match[0].length);
  const settings: Record<string, unknown> = {};
  const known = new Set<string>(PATTERN_SETTING_KEYS as string[]);

  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!known.has(key)) continue;
    const rawValue = trimmed.slice(idx + 1).trim();
    if (rawValue === '') continue;
    try {
      settings[key] = JSON.parse(rawValue);
    } catch {
      // Tolerate unquoted scalar strings.
      settings[key] = rawValue;
    }
  }

  return { settings: settings as PatternSettings, body };
}

/**
 * Return just the persona body (front-matter stripped). Used at materialization
 * so only the markdown content is substituted for @@Persona.
 */
export function stripPersonaFrontMatter(raw: string): string {
  const match = raw.match(FRONT_MATTER_RE);
  return match ? raw.slice(match[0].length) : raw;
}

/**
 * Serialize settings + body into a persona file. When there are no settings the
 * body is returned unchanged (no front-matter), keeping content-only personas
 * clean. Values are JSON-encoded so arrays and nested objects round-trip.
 */
export function serializePersonaFile(settings: PatternSettings, body: string): string {
  const lines: string[] = [];
  for (const key of PATTERN_SETTING_KEYS) {
    const value = settings[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  if (lines.length === 0) return body;
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}
