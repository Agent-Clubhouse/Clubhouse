export interface WildcardContext {
  agentName: string;       // e.g. "bold-falcon"
  standbyBranch: string;   // e.g. "bold-falcon/standby"
  agentPath: string;       // e.g. ".clubhouse/agents/bold-falcon/"
  sourceControlProvider?: string; // e.g. "github" or "azure-devops"
}

/**
 * Replace @@AgentName, @@StandbyBranch, @@Path, and @@SourceControlProvider
 * wildcards in a string, and process @@If(value)...@@EndIf conditional blocks.
 * Returns the input unchanged if no wildcards are found.
 */
export function replaceWildcards(text: string, ctx: WildcardContext): string {
  let result = text
    .replace(/@@AgentName/g, ctx.agentName)
    .replace(/@@StandbyBranch/g, ctx.standbyBranch)
    .replace(/@@Path/g, ctx.agentPath)
    .replace(/@@SourceControlProvider/g, ctx.sourceControlProvider || '');

  // Process @@If(value)...@@EndIf conditional blocks
  result = processConditionalBlocks(result, ctx);

  return result;
}

/**
 * Process @@If(value)...@@EndIf conditional blocks.
 * Keeps content when sourceControlProvider matches value, strips it otherwise.
 * Handles multiple blocks in the same text.
 */
function processConditionalBlocks(text: string, ctx: WildcardContext): string {
  // Match @@If(value)...@@EndIf — non-greedy, handles multiline
  return text.replace(
    /@@If\(([^)]+)\)\s*\n?([\s\S]*?)@@EndIf\s*\n?/g,
    (_match, value: string, content: string) => {
      if (ctx.sourceControlProvider === value) {
        return content;
      }
      return '';
    },
  );
}
