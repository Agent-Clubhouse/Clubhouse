import { useId } from 'react';
import {
  APPROVAL_POLICIES, APPROVAL_LABELS, SANDBOX_MODES, SANDBOX_LABELS,
  executionPolicyReason, supportsIndependentCodexPolicy, type AgentSandbox, type AgentApprovalPolicy,
} from '../../../shared/execution-policy';

/** Unset is intentional: opening or saving other settings never migrates a policy. */
export function ExecutionPolicyFields({ value, provider, runtime = 'chat', version, disabled, onChange, className }: {
  value: { sandbox?: AgentSandbox | null; approvalPolicy?: AgentApprovalPolicy | null };
  provider?: string;
  runtime?: 'chat' | 'terminal' | 'headless';
  version?: string;
  disabled?: boolean;
  className?: string;
  onChange: (patch: { sandbox?: AgentSandbox | null; approvalPolicy?: AgentApprovalPolicy | null }) => void;
}) {
  const id = useId();
  const versionReason = provider === 'codex-cli' && version && !supportsIndependentCodexPolicy(version)
    ? 'Independent policy settings require verified Codex 0.163.0 or newer on the target host.' : undefined;
  const reason = versionReason ?? executionPolicyReason(provider, runtime, {});
  return <div className="flex flex-col gap-2">
    <label htmlFor={`${id}-approval`}>Approval policy</label>
    <select id={`${id}-approval`} className={className} value={value.approvalPolicy ?? ''}
      disabled={disabled || (!!reason && !value.approvalPolicy)}
      onChange={(e) => onChange({ approvalPolicy: e.target.value as AgentApprovalPolicy || null })}>
      <option value="">Existing level default</option>
      {APPROVAL_POLICIES.map((p) => {
        const why = reason ?? executionPolicyReason(provider, runtime, { approvalPolicy: p });
        return <option key={p} value={p} disabled={!!why} title={why}>{APPROVAL_LABELS[p]}{why ? ` — ${why}` : ''}</option>;
      })}
    </select>
    <label htmlFor={`${id}-sandbox`}>Sandbox</label>
    <select id={`${id}-sandbox`} className={className} value={value.sandbox ?? ''}
      disabled={disabled || (!!reason && !value.sandbox)}
      onChange={(e) => onChange({ sandbox: e.target.value as AgentSandbox || null })}>
      <option value="">Existing level default</option>
      {SANDBOX_MODES.map((p) => <option key={p} value={p} disabled={!!reason}>{SANDBOX_LABELS[p]}</option>)}
    </select>
    <p className="text-xs text-ctp-subtext0">{reason ?? 'Codex 0.163+: independent of approval level. Network and writable roots follow the host’s Codex config. Never ask returns sandbox failures to the agent without prompting. Changes apply on the next start. Template overrides apply to durable agents; quick templates deliver parts only.'}</p>
  </div>;
}
