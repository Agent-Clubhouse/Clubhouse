import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedMcpProblem, ManagedSkillContent } from '../../../shared/managed-agents-types';
import { claudeMcpToolPrefix, driverReports, type ProviderSessionReport } from '../../../shared/chat/provider-inventory';
import { resolveManagedSetup, setupFingerprint, type DeliveryRecord } from './delivery';
import type { ManagedAgentsService } from './service';
import { withClubhouseSetup } from './service';
import type { ManagedPartRevision } from './activation-receipts';

export function partRevisions(parts: DeliveryRecord['parts']): ManagedPartRevision[] {
  return Object.entries(parts).map(([id, part]) => ({ id, revision: part.revision })).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One skill or MCP part against the provider's own report for the running session:
 * - `confirmed`: the report names it.
 * - `not_in_report`: the report covers that kind and leaves it out.
 * - `awaiting_report`: the provider reports that kind, but hasn't yet for this session (or the server is still connecting).
 * - `not_confirmed`: nothing to read it from (this provider never reports it, or the session isn't the one to check),
 *   or the report can't tie a name to this one part (`ambiguous`).
 */
export type PartVerification = 'confirmed' | 'not_in_report' | 'awaiting_report' | 'not_confirmed';

export type VerificationStatus = 'verified' | 'partial' | 'not_confirmed' | 'blocked';

/** The `name:` in a skill's SKILL.md front matter, which a provider may report instead of the folder name. */
export function skillDeclaredName(content: ManagedSkillContent): string | undefined {
  const file = content.files.find((f) => f.path === 'SKILL.md' && f.encoding !== 'base64');
  const front = file?.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const name = front?.[1].match(/^name:[ \t]*(.+?)[ \t]*$/m)?.[1].replace(/^(['"])(.*)\1$/, '$2');
  return name || undefined;
}

const RECOVERY = {
  setup_problems: 'Fix the diagnostics first: they stop the setup from reaching the session.',
  not_running: 'The agent is not running, so no session can report what it loaded. Its next start applies the setup; check again after it starts.',
  launch_not_recorded: 'This app run has no record of what the running session started with. restart_agent (with lifecycle authority) applies the current setup; check again after.',
  session_not_current: 'The running session started with another setup or provider. restart_agent (with lifecycle authority) applies the current one; check again after.',
  ambiguous_identity: 'Some parts share a name the provider reports the same way (an MCP server key that normalizes like another server\'s, or a skill folder or SKILL.md name another skill uses), so the report can\'t say which one loaded. Give each a distinct server key or skill name, then restart once.',
  not_in_provider_report: 'The provider\'s report for the current session leaves these parts out. Check the part (a skill\'s SKILL.md, an MCP server\'s command, environment or sign-in) and the MCP status shown, fix it, then restart once. Don\'t restart repeatedly hoping it appears.',
  awaiting_provider_report: 'The provider hasn\'t reported this session\'s skills and tools yet. Claude reports them when a turn starts; an MCP server may still be connecting. Check again with waitSeconds after the agent\'s next turn starts.',
  provider_does_not_report: 'The provider confirmed some parts but never reports the rest, so those stay not confirmed. Ask the user whether the agent\'s own use of them is enough evidence.',
  provider_evidence_unavailable: 'This provider and runtime report no model-visible skill or tool list, so loading stays not confirmed. Ask the user whether the agent\'s own use of them is enough evidence.',
} as const;

type Reason = keyof typeof RECOVERY;

/**
 * Activation evidence, each state kept apart: configured references, desired
 * revisions, the recorded materialization, the running session's launch setup,
 * and what the provider itself reported the session loaded (#2855). Only the
 * last can verify a part, and only for the session that started with the
 * current setup. A file write, a live process or an MCP handshake never does.
 */
export async function managedActivationFor(input: {
  service: ManagedAgentsService;
  agent: DurableAgentConfig;
  running: boolean;
  effectiveProvider?: string;
  materialized?: DeliveryRecord;
  deliveryFailed: boolean;
  mcpProblems?: ManagedMcpProblem[];
  /** The running chat session's provider report; absent for a terminal session or none running. */
  report?: ProviderSessionReport;
}) {
  const { agent, service, running, materialized, report } = input;
  const configured = agent.managed ? withClubhouseSetup(agent.managed) : null;
  const desired = configured ? await resolveManagedSetup(service, configured) : null;
  const fingerprint = desired ? setupFingerprint(agent, desired).fingerprint : null;
  const provider = input.effectiveProvider ?? agent.orchestrator;
  const partsMatch = materialized && fingerprint ? materialized.fingerprint === fingerprint && !materialized.missing && !desired?.missing.length : null;
  const providerMatch = materialized?.provider && provider ? materialized.provider === provider : null;
  const matchesDesired = partsMatch === false || providerMatch === false ? false : partsMatch === null || providerMatch === null ? null : true;
  const duplicates = desired ? desired.mcps.map((m) => m.content.serverKey).filter((key, index, keys) => keys.indexOf(key) !== index) : [];
  const lastRestart = await service.latestRestartReceipt(agent.id);
  const diagnostics: string[] = [
    ...(!configured ? ['not_managed'] : []),
    ...(desired?.missing.length ? ['missing_parts'] : []),
    ...(duplicates.length ? ['duplicate_mcp_keys'] : []),
    ...(input.deliveryFailed ? ['delivery_failed'] : []),
    ...(running && input.mcpProblems?.length ? ['missing_mcp_environment'] : []),
    ...(!running && lastRestart?.outcome === 'failed' ? ['restart_failed'] : []),
  ];
  const runningMatches = running && !input.deliveryFailed ? matchesDesired : null;

  // Provider evidence counts only for a running session that started with the current setup.
  const checkable = diagnostics.length === 0 && runningMatches === true;
  const reports = report && checkable ? driverReports(report.driver) : { skills: false, mcpTools: false };
  const inventory = checkable ? report?.inventory : undefined;
  const handshakes = new Map((report?.mcpHandshakes ?? []).map((s) => [s.name, s.status]));
  // A name the report can't tie to one part confirms nothing: skills by folder and SKILL.md name, MCP servers by tool prefix.
  const skillAliases = (desired?.skills ?? []).map((s) => {
    const declared = skillDeclaredName(s.content);
    return { id: s.id, names: [...new Set([s.content.skillName, ...(declared ? [declared] : [])])] };
  });
  const skillAmbiguous = (id: string) => {
    const mine = skillAliases.find((a) => a.id === id)?.names ?? [];
    return skillAliases.some((other) => other.id !== id && other.names.some((n) => mine.includes(n)));
  };
  const serverNames = [...new Set([...(desired?.mcps ?? []).map((m) => m.content.serverKey), ...handshakes.keys()])];
  const mcpAmbiguous = (serverKey: string) => {
    const prefix = claudeMcpToolPrefix(serverKey);
    return serverNames.some((name) => {
      if (name === serverKey) return false;
      const other = claudeMcpToolPrefix(name);
      return other.startsWith(prefix) || prefix.startsWith(other);
    });
  };
  const skillState = (skill: { id: string; content: ManagedSkillContent }): PartVerification => {
    if (!reports.skills) return 'not_confirmed';
    const names = inventory?.skills;
    if (!names) return 'awaiting_report';
    if (skillAmbiguous(skill.id)) return 'not_confirmed';
    const declared = skillDeclaredName(skill.content);
    return names.includes(skill.content.skillName) || (!!declared && names.includes(declared)) ? 'confirmed' : 'not_in_report';
  };
  const mcpState = (serverKey: string): PartVerification => {
    if (!reports.mcpTools) return 'not_confirmed';
    const tools = inventory?.mcpTools;
    if (!tools) return 'awaiting_report';
    if (mcpAmbiguous(serverKey)) return 'not_confirmed';
    const prefix = claudeMcpToolPrefix(serverKey);
    if (tools.some((t) => t.startsWith(prefix))) return 'confirmed';
    // A server still connecting at the report has no tools in it yet; the next report can list them.
    return handshakes.get(serverKey) === 'pending' ? 'awaiting_report' : 'not_in_report';
  };
  const parts = desired ? [
    ...desired.skills.map((s) => {
      const ambiguous = reports.skills && skillAmbiguous(s.id);
      return { id: s.id, kind: 'skill' as const, name: s.name, state: skillState(s), ...(ambiguous && { ambiguous: true }) };
    }),
    ...desired.mcps.map((m) => {
      const handshake = handshakes.get(m.content.serverKey);
      const ambiguous = reports.mcpTools && mcpAmbiguous(m.content.serverKey);
      return { id: m.id, kind: 'mcp' as const, name: m.name, serverKey: m.content.serverKey, state: mcpState(m.content.serverKey),
        ...(handshake && { handshake }), ...(ambiguous && { ambiguous: true }) };
    }),
  ] : [];
  const summary = (kind: 'skill' | 'mcp') => {
    const states = parts.filter((p) => p.kind === kind).map((p) => p.state);
    if (states.length === 0) return 'none_assigned';
    if (states.every((s) => s === 'confirmed')) return 'confirmed';
    if (states.includes('not_in_report')) return 'not_in_report';
    return 'not_confirmed';
  };
  const missing = parts.filter((p) => p.state === 'not_in_report');
  if (missing.length) diagnostics.push('not_in_provider_report');

  const reason: Reason | null = diagnostics.length && !missing.length ? 'setup_problems'
    : !running ? 'not_running'
      : runningMatches === null ? 'launch_not_recorded'
        : runningMatches === false ? 'session_not_current'
          : missing.length ? 'not_in_provider_report'
            : parts.some((p) => p.state === 'awaiting_report') ? 'awaiting_provider_report'
              : parts.some((p) => 'ambiguous' in p) ? 'ambiguous_identity'
                : parts.every((p) => p.state === 'confirmed') ? null
                  : parts.some((p) => p.state === 'confirmed') ? 'provider_does_not_report'
                    : 'provider_evidence_unavailable';
  const verificationStatus: VerificationStatus = reason === null ? 'verified'
    : reason === 'provider_does_not_report' ? 'partial'
      : reason === 'awaiting_provider_report' || reason === 'provider_evidence_unavailable' || reason === 'ambiguous_identity' ? 'not_confirmed'
        : 'blocked';

  return {
    agentId: agent.id,
    provider: provider ?? 'not_confirmed',
    status: diagnostics.length ? 'blocked' : verificationStatus === 'verified' ? 'verified' : running && matchesDesired ? 'partial' : 'pending',
    configured: { managed: !!configured, ...(configured && { blocks: configured.blocks, skills: configured.skills, mcps: configured.mcps }) },
    desired: desired ? {
      parts: partRevisions(setupFingerprint(agent, desired).parts),
      missing: desired.missing,
      fingerprint,
    } : null,
    materialized: input.deliveryFailed ? { status: 'failed', matchesDesired: false }
      : materialized ? { status: 'recorded', provider: materialized.provider ?? 'not_confirmed', deliveredAt: materialized.deliveredAt, parts: partRevisions(materialized.parts), missing: materialized.missing ?? 0, matchesDesired }
        : { status: 'not_confirmed', matchesDesired: null },
    running: {
      status: running ? 'running' : 'stopped',
      launchSetup: running && materialized && !input.deliveryFailed ? 'recorded_at_start' : 'not_confirmed',
      matchesDesired: runningMatches,
    },
    providerConfirmedLoaded: {
      skills: summary('skill'), mcpTools: summary('mcp'), instructions: 'not_confirmed', syntheticCheck: 'not_run',
      source: inventory ? `${inventory.provider} ${inventory.source}` : 'none',
      ...(inventory && { nativeSessionId: inventory.nativeSessionId }),
      parts,
      note: 'Only the provider\'s own report for the running session confirms a skill or MCP tool. File writes, session creation and MCP handshakes (shown as handshake) are not activation proof. Instructions are never confirmed. No prompt, tool operation or paid probe was run.',
    },
    verification: {
      status: verificationStatus,
      ...(reason && { reason, recovery: RECOVERY[reason] }),
      ...(missing.length && { notInReport: missing.map((p) => p.name) }),
      ...(parts.some((p) => 'ambiguous' in p) && { ambiguous: parts.filter((p) => 'ambiguous' in p).map((p) => p.name) }),
      attempts: report && checkable ? 1 : 0,
    },
    lastRestart,
    ...(lastRestart?.outcome === 'requested' && { restartNote: 'Restart intent exists, but its outcome is not recorded. It may still be waiting or may have been interrupted; do not assume completion or retry automatically.' }),
    diagnostics,
  };
}
