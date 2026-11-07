/**
 * Why an MCP server can't start (#2896, D95), said without values: the
 * variable names it needs that the session's environment doesn't have, or the
 * first line of the error its CLI reported.
 */
import type { McpServerDef } from './types';
import type { ManagedMcpProblem } from './managed-agents-types';

/** The server Clubhouse injects itself. Its variables come from Clubhouse at start, never from the person. */
const CLUBHOUSE_SERVER = 'clubhouse';

/**
 * Servers whose `env_vars` names aren't set (or are empty) in `env`, the
 * environment the CLI starts with. Names only: values are never read out.
 */
export function missingMcpEnv(servers: Record<string, McpServerDef>, env: Readonly<Record<string, string | undefined>>): ManagedMcpProblem[] {
  const out: ManagedMcpProblem[] = [];
  for (const [server, def] of Object.entries(servers)) {
    if (server === CLUBHOUSE_SERVER || !def.env_vars?.length) continue;
    const missing = def.env_vars.filter((name) => !env[name]);
    if (missing.length > 0) out.push({ server, missingEnv: [...new Set(missing)] });
  }
  return out;
}

function names(list: string[]): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** "WORKIQ_TENANT isn't set in your environment." */
export function missingEnvReason(missing: string[]): string {
  return `${names(missing)} ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} set in your environment.`;
}

/** The chat and terminal notice: "MCP server workiq can't start: WORKIQ_TENANT isn't set in your environment." */
export function missingEnvNotice(problem: ManagedMcpProblem): string {
  return `MCP server ${problem.server} can't start: ${missingEnvReason(problem.missingEnv)}`;
}

/**
 * A CLI's error text for a failed server, cut to its first line: an exit code
 * and the first stderr line where the CLI gives them. URL query strings are
 * removed, since they can carry tokens.
 */
export function mcpErrorLine(error: string | null | undefined): string | undefined {
  if (typeof error !== 'string') return undefined;
  const first = error.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return undefined;
  const stripped = first.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1?…');
  return stripped.length > 200 ? `${stripped.slice(0, 200)}…` : stripped;
}
