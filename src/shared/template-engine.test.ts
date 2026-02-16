import { describe, it, expect } from 'vitest';
import { expandTemplate, AgentContext } from './template-engine';

const fullContext: AgentContext = {
  agentName: 'test-agent',
  agentType: 'durable',
  worktreePath: '/project/.clubhouse/agents/test-agent',
  branch: 'test-agent/standby',
  projectPath: '/project',
};

describe('expandTemplate', () => {
  it('expands all known variables', () => {
    const template = '{{AGENT_NAME}} is a {{AGENT_TYPE}} agent at {{WORKTREE_PATH}} on {{BRANCH}} in {{PROJECT_PATH}}';
    const result = expandTemplate(template, fullContext);
    expect(result).toBe('test-agent is a durable agent at /project/.clubhouse/agents/test-agent on test-agent/standby in /project');
  });

  it('preserves unknown variables', () => {
    const template = '{{AGENT_NAME}} and {{UNKNOWN_VAR}}';
    const result = expandTemplate(template, fullContext);
    expect(result).toBe('test-agent and {{UNKNOWN_VAR}}');
  });

  it('handles empty branch for quick agents', () => {
    const quickContext: AgentContext = {
      agentName: 'quick-1',
      agentType: 'quick',
      worktreePath: '/project',
      branch: '',
      projectPath: '/project',
    };
    const template = 'Name: {{AGENT_NAME}}, Branch: {{BRANCH}}';
    const result = expandTemplate(template, quickContext);
    expect(result).toBe('Name: quick-1, Branch: ');
  });

  it('returns template unchanged when no variables present', () => {
    const template = 'No variables here.';
    const result = expandTemplate(template, fullContext);
    expect(result).toBe('No variables here.');
  });

  it('preserves unknown role variable', () => {
    const template = 'Role: {{ROLE}}';
    const result = expandTemplate(template, fullContext);
    expect(result).toBe('Role: {{ROLE}}');
  });
});
