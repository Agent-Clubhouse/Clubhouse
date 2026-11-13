/**
 * What binding an agent to a group project does (#3355, #3357): the MCP bind
 * handler's decision, kept here so it is one function the handler calls and
 * tests run against the real host and membership record.
 */
import { MCP_BIND_RESTORE, type McpBindCause, type McpBindResult } from '../../shared/mcp-unbind';
import { bindingManager } from './clubhouse-mcp';
import { addMember, isMembershipManaged } from './group-project-membership';
import { groupProjectHost } from './group-project-host';
import { appLog } from './log-service';

export interface GroupProjectBindHooks {
  /** Bind the wire directly: a group project whose members are still its wires. */
  bindNow: () => void;
  /** After a drawn wire made the agent a member of a managed group project. */
  joined?: () => void;
}

/**
 * Scope first, before anything is bound, recorded or made admin. A drawn wire
 * must be within the scope (an exclusion it can lift, as #3357's "drawing a wire
 * removes an exclusion"); one outside is refused and remembered as excluded. A
 * stored wire coming back is refused when excluded and otherwise left to the
 * record. Refusals are final, so the canvas stops retrying.
 */
export async function bindToGroupProject(groupProjectId: string, agentId: string, cause: McpBindCause | undefined, hooks: GroupProjectBindHooks): Promise<McpBindResult> {
  const managed = await isMembershipManaged(groupProjectId);
  const restore = cause === MCP_BIND_RESTORE;
  if (!(await groupProjectHost.admits(groupProjectId, agentId, { restore }).catch(() => false))) {
    appLog('core:mcp', 'info', 'Group project wire not bound: outside its scope', { meta: { agentId, targetId: groupProjectId, restore } });
    // A drawn wire refused for scope is remembered, so the canvas restoring it later is refused too.
    if (!restore) {
      await groupProjectHost.excludeOutOfScope(groupProjectId, agentId).catch((err) => {
        // telemetry-exempt: logged; the bind is refused either way
        appLog('core:mcp', 'warn', 'Could not record an out-of-scope group project wire', {
          meta: { agentId, targetId: groupProjectId, error: err instanceof Error ? err.message : String(err) },
        });
      });
    }
    return { notMember: true, reason: 'out_of_scope' };
  }
  if (!managed) {
    hooks.bindNow();
    return undefined;
  }
  if (!restore) {
    // Drawing the wire adds the member, lifting an exclusion the person made earlier.
    await addMember(groupProjectId, agentId);
    hooks.joined?.();
    return undefined;
  }
  // The record binds every member itself: a restore with no binding is a non-member.
  if (bindingManager.getBindingsForAgent(agentId).some((b) => b.targetId === groupProjectId)) return undefined;
  appLog('core:mcp', 'debug', 'Stored group project wire not bound: not a member', { meta: { agentId, targetId: groupProjectId } });
  return { notMember: true };
}
