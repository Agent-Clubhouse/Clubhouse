/** The host's read-only Settings summary (#3733). Display fields are explicitly allowlisted. */
import type { RemoteAgentSettings } from '../../shared/remote-agent-settings';
import { REMOTE_SETTINGS_MAX_BYTES } from '../../shared/remote-agent-settings';
import { accessLabel, startableAccess } from '../../shared/agent-access';
import { resolveIdleSleep } from '../../shared/idle-sleep';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { resolveAgentConfigTarget, readResolvedAgentConfig } from './agent-config-reader';
import { resolveOrchestrator } from './agent-system';
import { agentAccess } from './free-agent-settings';
import { resolveRuntimeMode } from './chat-runtime-settings';
import { resolveChatDriver } from './agent-runtime/chat-drivers';
import { chatIdleSettings } from './chat-idle-settings';
import { managedAgents, statusFor } from './managed-agents';
import { captureReadOnlyConfigTargetWitness } from './read-only-config-target';

const label = (text: string) => Array.from(text, (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').slice(0, 240);

/** Authorization is the existing pinned controller read policy, checked before and after all awaits. */
export async function readRemoteAgentSettings(agentId: string, authorized: () => boolean): Promise<{ status: number; body: unknown }> {
  const refused = () => ({ status: 403, body: { error: 'settings_read_refused' } });
  if (!authorized()) return refused();
  try {
    let target: Awaited<ReturnType<typeof resolveAgentConfigTarget>>;
    try { target = await resolveAgentConfigTarget(agentId, undefined, { strict: true }); }
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
    const provider = await resolveOrchestrator(project.path, agent.orchestrator);
    const mode = resolveRuntimeMode(provider.id, agent.runtimeMode);
    const runtime = mode.mode === 'chat' && resolveChatDriver(provider.id, mode.driver) ? 'chat' : 'terminal';
    const idle = resolveIdleSleep(agent.idleSleep, chatIdleSettings.getSettings().idleTimeoutMinutes);
    const result: RemoteAgentSettings = {
      version: 1, readOnly: true, agentId,
      provider: label(provider.displayName), providerId: provider.id, model: label(agent.model && agent.model !== 'default' ? agent.model : 'Default model'), runtime,
      access: provider.getCapabilities().permissions ? accessLabel(startableAccess(agentAccess(agent, project.path), provider.id, runtime)) : 'Set by the CLI',
      executionPolicy: [agent.approvalPolicy, agent.sandbox].filter(Boolean).join(' · ') || 'Existing level defaults',
      autoSleep: runtime === 'chat' ? `${idle.minutes ? `Sleeps after ${idle.minutes} min` : 'Never sleeps'}${idle.source === 'app' ? ' (host default)' : ''}` : null,
      context: agent.contextWindow ? label(agent.contextWindow) : null,
      setup: { state: 'error', managed: !!agent.managed, template: null, instructions: '', skills: null, mcps: null },
    };
    try {
      if (agent.managed) {
        const setup = agent.managed;
        if (setup.blocks.length + setup.skills.length + setup.mcps.length > 100) throw new Error('setup_limit');
        const service = managedAgents();
        const [entries, template, status] = await Promise.all([
          service.liveEntries(),
          setup.templateId ? service.getTemplate(setup.templateId).then((t) => label(t.name), () => 'Template unavailable') : null,
          statusFor(project.path, agent.id),
        ]);
        const names = (ids: string[]) => ids.map((id) => entries[id] ? label(entries[id].name) : 'No longer in the library');
        result.setup = {
          state: 'ok', managed: true, template,
          instructions: `${setup.blocks.length} ${setup.blocks.length === 1 ? 'block' : 'blocks'}`,
          skills: names(setup.skills), mcps: names(setup.mcps), waiting: status.waiting,
          ...(setup.updatedBy && { updatedBy: label(setup.updatedBy) }),
          ...(setup.updatedAt && { updatedAt: label(setup.updatedAt) }),
        };
      } else {
        // Reuse the bounded, no-symlink instruction reader. Only a count leaves this process.
        const evidence = await readResolvedAgentConfig(target);
        const text = evidence.instructions.text;
        result.setup = { state: 'ok', managed: false, template: null,
          instructions: text.trim() ? `Custom, ${text.trimEnd().split(/\r?\n/).length} lines${evidence.instructions.truncated ? ' (truncated)' : ''}` : 'None',
          // File/global MCP configuration is deliberately outside this metadata-only contract.
          skills: null, mcps: null };
      }
    } catch { /* telemetry-exempt: setup.state shows the bounded partial-read failure, without raw error text. */ }
    if (!authorized()) return refused();
    if (!targetWitness.current()) return { status: 409, body: { error: 'agent_inventory_changed' } };
    if (Buffer.byteLength(JSON.stringify(result)) > REMOTE_SETTINGS_MAX_BYTES) throw new Error('settings_limit');
    return { status: 200, body: result };
  } catch {
    // telemetry-exempt: remote errors never contain filesystem or configuration content.
    return authorized() ? { status: 500, body: { error: 'settings_read_failed' } } : refused();
  }
}
