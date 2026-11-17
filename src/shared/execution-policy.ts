/** Explicit overrides only. Absence preserves each provider/runtime's legacy defaults. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type AgentSandbox = typeof SANDBOX_MODES[number];
export const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;
export type AgentApprovalPolicy = typeof APPROVAL_POLICIES[number];
export interface ExecutionPolicy {
  sandbox?: AgentSandbox;
  approvalPolicy?: AgentApprovalPolicy;
}
export const SANDBOX_LABELS: Record<AgentSandbox, string> = {
  'read-only': 'Read only', 'workspace-write': 'Workspace write', 'danger-full-access': 'No sandbox',
};
export const APPROVAL_LABELS: Record<AgentApprovalPolicy, string> = {
  untrusted: 'Ask for untrusted commands', 'on-request': 'Ask when needed', never: 'Never ask',
};
export function hasExecutionPolicy(policy: { sandbox?: AgentSandbox | null; approvalPolicy?: AgentApprovalPolicy | null }): boolean {
  return policy.sandbox != null || policy.approvalPolicy != null;
}
export function validateExecutionPolicy(policy: { sandbox?: unknown; approvalPolicy?: unknown }): void {
  if (policy.sandbox != null && !(SANDBOX_MODES as readonly unknown[]).includes(policy.sandbox)) throw new Error('Unknown sandbox policy');
  if (policy.approvalPolicy != null && !(APPROVAL_POLICIES as readonly unknown[]).includes(policy.approvalPolicy)) throw new Error('Unknown approval policy');
}
/** Unsupported choices fail closed; switching provider or falling back never drops a restriction. */
export function executionPolicyReason(provider: string | undefined, runtime: 'chat' | 'terminal' | 'headless', policy: ExecutionPolicy, resume = false): string | undefined {
  if (provider !== 'codex-cli') return 'No verified mapping or enforcement of these Codex sandbox and approval policies for this provider/runtime. Its native permissions are unchanged.';
  if (runtime === 'headless' && resume) return 'Codex exec resume cannot apply independent sandbox or approval flags. Use chat or the terminal.';
  if (runtime === 'headless' && policy.approvalPolicy && policy.approvalPolicy !== 'never') return 'Headless Codex cannot show approval requests. Choose Never ask, chat or the terminal.';
  if (runtime === 'terminal' && policy.approvalPolicy === 'untrusted') return 'This Codex terminal only supports Ask when needed or Never ask. Untrusted-command approval requires chat.';
  return undefined;
}
export function assertExecutionPolicy(provider: string | undefined, runtime: 'chat' | 'terminal' | 'headless', policy: ExecutionPolicy, resume = false): void {
  validateExecutionPolicy(policy);
  if (policy.sandbox === null || policy.approvalPolicy === null) throw new Error('Launch policies cannot be null');
  if (!hasExecutionPolicy(policy)) return;
  const reason = executionPolicyReason(provider, runtime, policy, resume);
  if (reason) throw new Error(reason);
}

/** Conservative access ceiling for callers setting independent policies through tools. */
export function accessWithExecutionPolicy<T extends 'plan' | 'ask' | 'auto_edit' | 'auto' | 'full_access'>(level: T, policy: { sandbox?: AgentSandbox | null; approvalPolicy?: AgentApprovalPolicy | null }): 'plan' | 'ask' | 'auto_edit' | 'auto' | 'full_access' {
  const levels = ['plan', 'ask', 'auto_edit', 'auto', 'full_access'] as const;
  const required = policy.sandbox === 'danger-full-access' ? 'full_access'
    : policy.approvalPolicy === 'never' ? 'auto'
    : policy.approvalPolicy === 'on-request' || policy.sandbox === 'workspace-write' ? 'auto_edit' : 'plan';
  return levels[Math.max(levels.indexOf(level), levels.indexOf(required))];
}

/** Verified stable app-server schema floor, independent of the centrally enforced tested maximum. */
export function supportsIndependentCodexPolicy(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 163);
}
