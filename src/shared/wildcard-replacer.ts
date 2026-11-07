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
 * Replace @@AgentName, @@StandbyBranch, @@Path, @@SourceControlProvider,
 * @@BuildCommand, @@TestCommand and @@LintCommand in a string. Returns the
 * input unchanged if no wildcards are found.
 *
 * Anything else stays exactly as written: @@Mission and @@Persona (D60), and
 * @@If / @@EndIf, which only Clubhouse Mode resolved (D10, retired in #2901).
 */
export function replaceWildcards(text: string, ctx: WildcardContext): string {
  return text
    .replace(/@@AgentName/g, ctx.agentName)
    .replace(/@@StandbyBranch/g, ctx.standbyBranch)
    .replace(/@@Path/g, ctx.agentPath)
    .replace(/@@SourceControlProvider/g, ctx.sourceControlProvider || '')
    .replace(/@@BuildCommand/g, ctx.buildCommand || 'npm run build')
    .replace(/@@TestCommand/g, ctx.testCommand || 'npm test')
    .replace(/@@LintCommand/g, ctx.lintCommand || 'npm run lint');
}
