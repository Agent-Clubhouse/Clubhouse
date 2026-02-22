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
 * Reverse of replaceWildcards — replaces resolved agent-specific values back
 * to wildcard tokens. Processes longest values first to avoid partial matches
 * (e.g. agentPath before agentName when agentPath contains agentName).
 *
 * Cannot reverse @@If/@@EndIf blocks (lossy), but this is acceptable since
 * the primary use case is permissions and simple string values.
 */
export function unreplaceWildcards(text: string, ctx: WildcardContext): string {
  // Build replacement pairs sorted by value length (longest first)
  const pairs: Array<{ value: string; token: string }> = [
    { value: ctx.standbyBranch, token: '@@StandbyBranch' },
    { value: ctx.agentPath, token: '@@Path' },
    { value: ctx.agentName, token: '@@AgentName' },
  ];
  if (ctx.sourceControlProvider) {
    pairs.push({ value: ctx.sourceControlProvider, token: '@@SourceControlProvider' });
  }

  // Sort longest-value-first to avoid partial matches
  pairs.sort((a, b) => b.value.length - a.value.length);

  let result = text;
  for (const { value, token } of pairs) {
    if (value) {
      result = result.split(value).join(token);
    }
  }
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
