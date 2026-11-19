/** The host's read-only Settings summary (#3733). Display fields are explicitly allowlisted. */
import type { RemoteAgentSettings } from '../../shared/remote-agent-settings';
import { REMOTE_SETTINGS_MAX_BYTES } from '../../shared/remote-agent-settings';
import { accessLabel, startableAccess } from '../../shared/agent-access';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { resolveAgentConfigTarget, readResolvedAgentConfig, type AgentConfigTarget } from './agent-config-reader';
import { captureDisplayProvider, type DisplayProviderSnapshot } from './display-provider';
import { readAgentAccessForDisplay } from './free-agent-settings';
import { readRuntimeModeForDisplay } from './chat-runtime-settings';
import { resolveChatDriver } from './agent-runtime/chat-drivers';
import { readIdleSleepForDisplay } from './chat-idle-settings';
import { readRemoteManagedSettings, type ManagedSettingsEvidence } from './remote-managed-settings';
import { captureReadOnlyConfigTargetWitness } from './read-only-config-target';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import type { RemoteDetailsCard } from '../../shared/remote-agent-details';
import { card, row } from './remote-details-presentation';

const label = (text: string) => Array.from(text, (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').slice(0, 240);

/** Internal host projection only; transport sends body, never private receipt functions. */
export interface RemoteSettingsRead { status: number; body: unknown; display?: RemoteDetailsCard; managedEvidence?: ManagedSettingsEvidence }
interface ReadOptions { admittedTarget?: AgentConfigTarget; admittedProvider?: DisplayProviderSnapshot; receipts?: DisplayReceipt[] }

function observe<T>(read: () => DisplayValue<T>, receipts: DisplayReceipt[]): DisplayValue<T> {
  const value = read();
  const signature = (item: DisplayValue<T>) => JSON.stringify({ state: item.state, value: item.state === 'ok' ? item.value : undefined,
    sources: item.inputs.map(({ field, source }) => ({ field, source })) });
  const admitted = signature(value);
  receipts.push({ current: () => { try { return signature(read()) === admitted; } catch { return false; } } });
  return value;
}

/** Authorization is the existing pinned controller read policy, checked before and after all awaits. */
export async function readRemoteAgentSettings(agentId: string, authorized: () => boolean, options: ReadOptions = {}): Promise<RemoteSettingsRead> {
  const refused = () => ({ status: 403, body: { error: 'settings_read_refused' } });
  if (!authorized()) return refused();
  try {
    let target: Awaited<ReturnType<typeof resolveAgentConfigTarget>>;
    try { target = options.admittedTarget ?? await resolveAgentConfigTarget(agentId, undefined, { strict: true }); }
    catch (error) { // telemetry-exempt: distinguish a missing target from a bounded read error without exposing host details.
      if (!authorized()) return refused();
      return error instanceof Error && error.message === 'No registered agent matches that reference.'
        ? { status: 404, body: { error: 'agent_not_found' } }
        : { status: 500, body: { error: 'settings_read_failed' } };
    }
    const { agent, project } = target;
    // This endpoint accepts ids, never a name resolved on behalf of an untrusted caller.
    if (agent.id !== agentId || isDisposedAgent(agent)) return { status: 404, body: { error: 'agent_not_found' } };
    if (!authorized()) return refused();
    const targetWitness = captureReadOnlyConfigTargetWitness(target);
    const providerRead = options.admittedProvider ?? captureDisplayProvider(target);
    if (options.admittedProvider && !providerRead.matchesTarget(target)) throw new Error('provider_target_mismatch');
    const provider = providerRead.provider;
    const receipts: DisplayReceipt[] = [providerRead.receipt];
    const runtimeOverride = agent.runtimeMode, accessChoice = { access: agent.access, freeAgentMode: agent.freeAgentMode }, idleOverride = agent.idleSleep;
    const mode = provider ? observe(() => readRuntimeModeForDisplay(provider.id, runtimeOverride), receipts) : { state: 'unavailable' as const, inputs: providerRead.selection.inputs };
    const runtime = mode.state === 'ok' ? mode.value.mode === 'chat' && resolveChatDriver(provider!.id, mode.value.driver) ? 'chat' : 'terminal' : null;
    const permissions = provider?.getCapabilities?.().permissions;
    const access = permissions === true ? observe(() => readAgentAccessForDisplay(accessChoice, project.path), receipts) : null;
    const idle = runtime === 'terminal' ? null : observe(() => readIdleSleepForDisplay(idleOverride), receipts);
    const accessText = permissions === false ? 'Set by the CLI' : runtime && access?.state === 'ok' ? accessLabel(startableAccess(access.value, provider!.id, runtime)) : null;
    const sleepText = idle?.state === 'ok' ? `${idle.value.minutes ? `Sleeps after ${idle.value.minutes} min` : 'Never sleeps'}${idle.value.source === 'app' ? ' (host default)' : ''}` : null;
    const complete = runtime !== null && accessText !== null && (runtime !== 'chat' || sleepText !== null);
    const shown = card('settings', 'Settings');
    // When v1 cannot truthfully represent required evidence, corresponding
    // Details rows retain independently known facts without inventing an enum.
    if (!complete) {
      shown.state = 'error'; shown.summary = 'Some host settings are unavailable';
      row(shown, 'Next start CLI', provider?.displayName || (providerRead.selection.state === 'ok' ? `${providerRead.selection.value} (unavailable on host)` : 'Unavailable from host metadata')); row(shown, 'Next start model', agent.model && agent.model !== 'default' ? agent.model : 'Default model');
      row(shown, 'Next wake', runtime === null ? 'Unavailable from host settings' : runtime === 'chat' ? 'Chat' : 'CLI');
      row(shown, 'Next start access', accessText ?? 'Unavailable from host settings');
      if (runtime === null && access?.state === 'ok') row(shown, 'Saved access', accessLabel(access.value));
      row(shown, 'Chat auto-sleep', runtime === 'terminal' ? 'Not applicable to CLI' : sleepText ?? 'Unavailable from host settings');
      row(shown, 'Sandbox and approvals', [agent.approvalPolicy, agent.sandbox].filter(Boolean).join(' · ') || 'Existing level defaults');
      row(shown, 'Next start context', agent.contextWindow);
      shown.notes.push('Unavailable settings are not inferred from this machine or from a previous run. Other host fields are shown independently.');
    }
    row(shown, 'Next start effort', agent.effort);
    shown.notes.push('Saved next-start preferences; current runtime reports are shown separately.');
    const inputs = [...providerRead.selection.inputs, ...mode.inputs, ...(access?.inputs ?? []), ...(idle?.inputs ?? [])];
    for (const input of inputs) shown.notes.push(`${input.field}: ${input.source === 'host-cache' ? 'established host cache' : input.source === 'primary' ? 'host primary metadata' : 'selected agent metadata'} observed ${new Date(input.observedAt).toISOString()}.`);
    const result: RemoteAgentSettings = {
      version: 1, readOnly: true, agentId,
      provider: label(provider?.displayName ?? ''), ...(provider && { providerId: provider.id }), model: label(agent.model && agent.model !== 'default' ? agent.model : 'Default model'),
      // This object is serialized only when complete. Required unknown fields
      // never cross the v1 boundary with a fabricated fallback value.
      runtime: runtime!, access: accessText!,
      executionPolicy: label([agent.approvalPolicy, agent.sandbox].filter(Boolean).join(' · ') || 'Existing level defaults'),
      autoSleep: runtime === 'chat' ? sleepText : null,
      context: agent.contextWindow ? label(agent.contextWindow) : null,
      setup: { state: 'error', managed: !!agent.managed, template: null, instructions: '', skills: null, mcps: null },
    };
    let managedEvidence: ManagedSettingsEvidence | undefined;
    try {
      if (agent.managed) {
        managedEvidence = await readRemoteManagedSettings(agent, shown, receipts, authorized);
        result.setup = managedEvidence.setup;
      } else {
        // Reuse the bounded, no-symlink instruction reader. Only a count leaves this process.
        if (!provider) throw new Error('provider_unavailable');
        const evidence = await readResolvedAgentConfig(target, { provider, receipts });
        const text = evidence.instructions.text;
        result.setup = { state: 'ok', managed: false, template: null,
          instructions: text.trim() ? `Custom, ${text.trimEnd().split(/\r?\n/).length} lines${evidence.instructions.truncated ? ' (truncated)' : ''}` : 'None',
          // File/global MCP configuration is deliberately outside this metadata-only contract.
          skills: null, mcps: null };
      }
    } catch { /* telemetry-exempt: setup.state shows the bounded partial-read failure, without raw error text. */ }
    if (!authorized()) return refused();
    if (!targetWitness.current()) return { status: 409, body: { error: 'agent_inventory_changed' } };
    if (receipts.some((receipt) => !receipt.current())) return { status: 409, body: { error: 'settings_evidence_changed' } };
    options.receipts?.push(...receipts);
    if (!complete) {
      if (result.setup.state === 'ok') {
        row(shown, 'Managed', result.setup.managed ? 'By Clubhouse' : 'No'); row(shown, 'Instructions', result.setup.instructions);
        row(shown, 'Template', result.setup.template);
        row(shown, 'Skills', result.setup.skills === null ? 'Not shared by host' : result.setup.skills.join(', ') || 'None');
        row(shown, 'MCP servers', result.setup.mcps === null ? 'Not shared by host' : result.setup.mcps.join(', ') || 'None');
      } else shown.notes.push('The configured setup summary is unavailable.');
      return { status: 503, body: { error: 'settings_evidence_unavailable' }, display: shown, ...(managedEvidence && { managedEvidence }) };
    }
    if (Buffer.byteLength(JSON.stringify(result)) > REMOTE_SETTINGS_MAX_BYTES) throw new Error('settings_limit');
    return { status: 200, body: result, display: shown, ...(managedEvidence && { managedEvidence }) };
  } catch {
    // telemetry-exempt: remote errors never contain filesystem or configuration content.
    return authorized() ? { status: 500, body: { error: 'settings_read_failed' } } : refused();
  }
}
