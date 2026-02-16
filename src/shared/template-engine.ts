/**
 * Simple template engine for expanding {{VAR}} placeholders.
 * Unknown variables are left as-is.
 */

export interface AgentContext {
  agentName: string;
  agentType: 'durable' | 'quick';
  worktreePath: string;
  branch: string;
  projectPath: string;
}

const CONTEXT_TO_VAR: Record<keyof AgentContext, string> = {
  agentName: 'AGENT_NAME',
  agentType: 'AGENT_TYPE',
  worktreePath: 'WORKTREE_PATH',
  branch: 'BRANCH',
  projectPath: 'PROJECT_PATH',
};

export function expandTemplate(template: string, context: AgentContext): string {
  const vars: Record<string, string> = {};
  for (const [key, varName] of Object.entries(CONTEXT_TO_VAR)) {
    const value = context[key as keyof AgentContext];
    if (value !== undefined) {
      vars[varName] = String(value);
    }
  }

  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    return vars[varName] !== undefined ? vars[varName] : match;
  });
}
