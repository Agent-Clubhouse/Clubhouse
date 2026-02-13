/**
 * Built-in CLAUDE.md templates and default permissions for agents.
 */

export const DURABLE_CLAUDE_MD_TEMPLATE = `# Agent: {{AGENT_NAME}}

- **Type**: {{AGENT_TYPE}}
- **Worktree**: {{WORKTREE_PATH}}
- **Branch**: {{BRANCH}}

## Scoping Rules

- Stay in your worktree: \`{{WORKTREE_PATH}}\`
- Do NOT modify files in other agent worktrees or the project root
- Do NOT touch \`.clubhouse/\` configuration files

## Git Workflow

When starting a new task:

1. \`git fetch origin\`
2. \`git checkout -b {{AGENT_NAME}}/description origin/main\`
3. Do your work
4. Push your branch: \`git push -u origin HEAD\`
5. Return to standby: \`git checkout {{BRANCH}}\`

## Commit Discipline

- Commit after each meaningful change
- Write clear, descriptive commit messages
- Never use \`git add -A\` blindly — review what you're staging
- Prefer \`git add <specific-files>\`
`;

export const QUICK_CLAUDE_MD_TEMPLATE = `# Agent: {{AGENT_NAME}}

- **Type**: {{AGENT_TYPE}}

## Scope

- Complete the focused task you've been given
- Stay in your working directory
- No branch management or commits unless explicitly asked
`;

export const DEFAULT_DURABLE_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)'];

export const DEFAULT_QUICK_PERMISSIONS = ['Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Write'];
