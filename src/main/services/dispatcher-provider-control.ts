import * as projectStore from './project-store';
/** Provider control uses the existing Dispatcher/connected-target authority.
 * hands-off and ask-before-start permit saving; ask-everything requires the
 * manual settings surface. This never starts an agent or grants helper control.
 */
import { previewAgentProvider, changeAgentProvider } from './agent-provider-control';
import { agentRegistry } from './agent-registry';
import { isDispatcherAgent } from './clubhouse-mcp/dispatcher-gate';
import { mcpCallAccess } from './clubhouse-mcp/mcp-call-gate';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { isBindingRemovedByUser } from './persisted-bindings';
import { readAgentCensus, isConnectedOrchestrator } from './dispatcher-connections';
import { appendAudit, auditString } from './dispatcher-audit';
import { MobileControlError } from './mobile-control';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';

export async function dispatcherProviderControl(callerId: string, targetId: string, change: boolean, args: Record<string, unknown>) {
  const suffix = change ? 'change_provider' : 'preview_provider';
  const refuse = (code: string): never => { throw new MobileControlError(code, 403); };
  const version = bindingManager.getVersion();
  let projectPath = '';
  const assertAuthorized = async () => {
    const syncCheck = () => {
      if (!isDispatcherAgent(callerId) || mcpCallAccess(callerId, agentRegistry.get(callerId)?.projectPath) !== 'open') refuse('not_dispatcher');
      if (callerId === targetId) refuse('self_target');
      const wire = bindingManager.getBindingsForAgent(callerId).find((b) => b.targetId === targetId && b.targetKind === 'agent');
      if (!wire || isBindingRemovedByUser(callerId, targetId) || bindingManager.getVersion() !== version) refuse('permission_revoked');
      // A denied sleep control cannot be bypassed by the new saved-provider control.
      if (wire!.disabledTools?.some((tool) => [suffix, 'sleep_agent'].includes(tool))) refuse('tool_denied');
    };
    syncCheck();
    const entry = (await readAgentCensus()).agents.get(targetId);
    syncCheck();
    if (!entry || !isConnectedOrchestrator(entry.agent, entry.policy)) refuse('not_connected_orchestrator');
    if (entry!.policy.control === 'ask-everything') refuse('control_requires_user');
    if (projectPath && projectPath !== entry!.projectPath) refuse('stale_state');
    projectPath = entry!.projectPath;
  };
  try {
    if (Object.keys(args).some((key) => !['provider', ...(change ? ['expectedState'] : [])].includes(key))
      || typeof args.provider !== 'string' || !args.provider || args.provider.length > 128
      || (change && (typeof args.expectedState !== 'string' || !args.expectedState))) refuse('invalid_args');
    await assertAuthorized();
    const actor = { key: `dispatcher:${callerId}:${targetId}:${version}`, assertAuthorized };
    const result = change
      ? await changeAgentProvider(projectPath, targetId, args.provider as string, args.expectedState as string, actor)
      : await previewAgentProvider(projectPath, targetId, args.provider as string, actor);
    const audited = await appendAudit({ tool: suffix, actorId: callerId, targets: [targetId], requested: { provider: auditString(args.provider) }, outcome: 'ok' });
    if (change) {
      const project = (await projectStore.list()).find((p) => p.path === projectPath);
      if (project) broadcastToAllWindows(IPC.WINDOW.REQUEST_DURABLE_RELOAD, project.id);
    }
    return { ...result, ...(!audited && { audit_warning: 'The result could not be written to the audit record.' }) };
  } catch (err) {
    const code = err instanceof MobileControlError ? err.code : 'provider_control_failed';
    await appendAudit({ tool: suffix, actorId: callerId, targets: [auditString(targetId)], outcome: 'refused', code });
    throw err;
  }
}
