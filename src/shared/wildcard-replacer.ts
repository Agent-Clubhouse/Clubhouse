export interface WildcardContext {
  agentName: string;       // e.g. "bold-falcon"
  standbyBranch: string;   // e.g. "bold-falcon/standby"
  agentPath: string;       // e.g. ".clubhouse/agents/bold-falcon/"
  sourceControlProvider?: string; // e.g. "github" or "azure-devops"
  buildCommand?: string;   // e.g. "npm run build"
  testCommand?: string;    // e.g. "npm test"
  lintCommand?: string;    // e.g. "npm run lint"
}

/**
 * The wildcards a Clubhouse-managed agent's text can use (#2902). Managed
 * delivery, quick-agent templates and Preview fill these and leave every other
 * `@@` token as written: @@SourceControlProvider, @@BuildCommand,
 * @@TestCommand and @@LintCommand (the built-in build, test, lint and validate
 * skills replace them), @@Mission and @@Persona (D60), and @@If / @@EndIf (D10).
 */
export const MANAGED_WILDCARDS = ['AgentName', 'StandbyBranch', 'Path'] as const;

/** Replace only the managed wildcards (MANAGED_WILDCARDS). */
export function replaceManagedWildcards(text: string, ctx: Pick<WildcardContext, 'agentName' | 'standbyBranch' | 'agentPath'>): string {
  return text
    .replace(/@@AgentName/g, ctx.agentName)
    .replace(/@@StandbyBranch/g, ctx.standbyBranch)
    .replace(/@@Path/g, ctx.agentPath);
}

/**
 * Replace @@AgentName, @@StandbyBranch, @@Path, @@SourceControlProvider,
 * @@BuildCommand, @@TestCommand and @@LintCommand in a string. Returns the
 * input unchanged if no wildcards are found. For what isn't Clubhouse-managed:
 * an unmanaged agent's project MCP JSON, and the switch to managed
 * (managed-agents/legacy-migration). Managed text uses replaceManagedWildcards.
 *
 * Anything else stays exactly as written: @@Mission and @@Persona (D60), and
 * @@If / @@EndIf, which only Clubhouse Mode resolved (D10, retired in #2901).
 */
export function replaceWildcards(text: string, ctx: WildcardContext): string {
  return replaceManagedWildcards(text, ctx)
    .replace(/@@SourceControlProvider/g, ctx.sourceControlProvider || '')
    .replace(/@@BuildCommand/g, ctx.buildCommand || 'npm run build')
    .replace(/@@TestCommand/g, ctx.testCommand || 'npm test')
    .replace(/@@LintCommand/g, ctx.lintCommand || 'npm run lint');
}
