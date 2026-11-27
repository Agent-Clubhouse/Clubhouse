/** Tool-list identity selection for E2E consumers of opaque agent callable keys. */
export interface ListedMcpTool {
  name: string;
  description: string;
}

/** Match the complete published address, never a readable name fragment or a guessed key. */
export function agentToolsForTarget(tools: readonly ListedMcpTool[], targetId: string, suffix: string): ListedMcpTool[] {
  return tools.filter((tool) => {
    if (!tool.name.startsWith('clubhouse__') || !tool.name.endsWith(`__${suffix}`)) return false;
    // User instructions can contain arbitrary text; only the preceding server
    // attribution is identity data. Multiple/malformed attributions fail loudly.
    // The marker was renamed with the 1.0 terms (#2783); older peers still send the old one.
    const serverDescription = tool.description.split(/\n\n\[(?:CONNECTION INSTRUCTIONS FROM THE USER|WIRE INSTRUCTIONS — user-supplied)\]\n/)[0];
    const targets = [...serverDescription.matchAll(/(?:^|\n)Target: ([^\n]*)/g)];
    if (targets.length !== 1) throw new Error(`Tool ${tool.name} must expose exactly one structured Target`);
    let target: unknown;
    try { target = JSON.parse(targets[0][1]); }
    catch { throw new Error(`Tool ${tool.name} exposes invalid Target JSON`); }
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || !('id' in target) || typeof target.id !== 'string'
      || !('name' in target) || typeof target.name !== 'string'
      || !('project' in target) || typeof target.project !== 'string') {
      throw new Error(`Tool ${tool.name} exposes invalid Target fields`);
    }
    return target.id === targetId;
  });
}

/** A required callable has exactly one current identity; zero/multiple is a test failure. */
export function requireAgentToolForTarget(tools: readonly ListedMcpTool[], targetId: string, suffix: string): string {
  const matches = agentToolsForTarget(tools, targetId, suffix);
  if (matches.length !== 1) throw new Error(`Expected one ${suffix} tool for target ${targetId}; found ${matches.length}`);
  return matches[0].name;
}
