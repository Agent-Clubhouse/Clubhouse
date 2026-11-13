/**
 * Group Project Lifecycle — tracks membership changes and posts
 * join/leave events to the system topic on the bulletin board.
 */

import { holdsGrant } from './clubhouse-mcp/grant-check';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { consumeRestoredBinding } from './persisted-bindings';
import { groupProjectRegistry } from './group-project-registry';
import { groupProjectHost } from './group-project-host';
import * as ptyManager from './pty-manager';
import { agentRegistry } from './agent-registry';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { appLog } from './log-service';
import { getAgentRuntime } from './agent-runtime';
import { getAgentOrchestrator } from './agent-registry';
import { getProvider } from '../orchestrators/registry';
import { pollingStartMsg } from '../../shared/polling-messages';
import { mcpCallAccess } from './clubhouse-mcp/mcp-call-gate';
import { notePollingStart } from './group-project-polling-runs';

/** Debounce window (ms) — suppress rejoins within this period after a leave unless agent is verified running. */
const REJOIN_DEBOUNCE_MS = 30_000;

/** Default delay (ms) before sending Enter after bracketed paste. */
const DEFAULT_PASTE_DELAY_MS = 400;

/** Get the orchestrator-specific paste delay for an agent. */
function getPasteDelayMs(agentId: string): number {
  const orchId = getAgentOrchestrator(agentId);
  if (orchId) {
    const provider = getProvider(orchId);
    if (provider) return provider.getPasteSubmitTiming().initialDelayMs;
  }
  return DEFAULT_PASTE_DELAY_MS;
}

/**
 * Inject a group-project message (polling nudges, join notices). Chat agents
 * get it through their runtime; terminal agents keep the bracketed paste +
 * delayed Enter that polling has always used.
 */
export function injectPtyMessage(agentId: string, message: string): void {
  const runtime = getAgentRuntime(agentId);
  if (runtime?.kind === 'chat') {
    runtime.sendMessage(message, { source: 'group_project' }).catch((err) => {
      appLog('core:group-project', 'warn', 'Chat injection failed', {
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
    });
    return;
  }
  if (ptyManager.isStopping(agentId)) {
    // The process is exiting and would swallow the message.
    appLog('core:group-project', 'info', 'PTY injection skipped: the agent is shutting down', { meta: { agentId } });
    return;
  }
  try {
    ptyManager.write(agentId, `\x1b[200~${message}\x1b[201~`);
    setTimeout(() => ptyManager.write(agentId, '\r'), getPasteDelayMs(agentId));
  } catch (err) {
    appLog('core:group-project', 'warn', 'PTY injection failed', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

let recordDecidesMembers: (groupProjectId: string) => boolean = () => false;

/** The membership module says which group projects take their members from their record (#3357). */
export function setRecordDecidesMembers(check: (groupProjectId: string) => boolean): void {
  recordDecidesMembers = check;
}

/** Tracks known memberships: projectId → Set<agentId> */
const memberships = new Map<string, Set<string>>();
/** Cached agent names: agentId → human-readable name */
const agentNames = new Map<string, string>();
/** Tracks recent leave timestamps: `${agentId}:${projectId}` → timestamp */
const recentLeaves = new Map<string, number>();

let initialized = false;
let unsubscribe: (() => void) | null = null;

/** Initialize lifecycle tracking. Call once at startup. */
export function initGroupProjectLifecycle(): void {
  if (initialized) return;
  initialized = true;

  unsubscribe = bindingManager.onChange((agentId: string) => {
    void syncMemberships(agentId);
  });

  appLog('core:group-project', 'info', 'Group project lifecycle initialized');
}

/** Check whether an agent has a live process (PTY or registered runtime). */
export function isAgentAlive(agentId: string): boolean {
  if (ptyManager.isRunning(agentId)) return true;
  // Agent may be running in headless mode — check registry
  return agentRegistry.get(agentId) !== undefined;
}

/**
 * Whether a member can use group project tools now. A polling instruction is
 * no use to one that can't, and would spend its tokens for nothing. Ordinary
 * messages, shoulder taps included, don't ask this.
 */
export function canPoll(agentId: string): boolean {
  return mcpCallAccess(agentId, agentRegistry.get(agentId)?.projectPath) === 'open'
    // Polling reads the board for it: not when reading the board is turned off (#2971).
    && holdsGrant(agentId, 'group_project.read', { kind: 'group_project', groupRole: 'member' });
}

async function syncMemberships(agentId: string): Promise<void> {
  const bindings = bindingManager.getBindingsForAgent(agentId);
  const currentProjects = new Set(
    bindings
      .filter(b => b.targetKind === ('group-project' as BindingTargetKind))
      .map(b => b.targetId),
  );

  // Find which projects this agent was previously in
  for (const [projectId, members] of memberships) {
    if (members.has(agentId) && !currentProjects.has(projectId)) {
      // Agent left this project
      members.delete(agentId);
      if (members.size === 0) memberships.delete(projectId);

      // Record the leave timestamp for debouncing
      recentLeaves.set(`${agentId}:${projectId}`, Date.now());

      // Lead and admin end with membership (#3360): excluded, out of scope, disposed or unwired.
      // Loaded here: the roles module reads the grants store, which this module's users needn't load.
      void import('./group-project-roles').then(({ revokeGroupProjectRoles }) => revokeGroupProjectRoles(projectId, agentId)).catch((err) => {
        // telemetry-exempt: a grant on a group project the agent left still needs membership to reach any tool; logged
        appLog('core:group-project', 'warn', 'Could not take lead and admin from an agent that left', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
      });

      const agentName = agentNames.get(agentId) || resolveAgentName(agentId);
      try {
        const proj = await groupProjectRegistry.get(projectId);
        const projName = proj?.name || projectId;
        await groupProjectHost.post(projectId, 'system', 'system', `${agentName} left project "${projName}"`);
      } catch (err) {
        appLog('core:group-project', 'warn', 'Failed to post leave event', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  // Check for new memberships
  for (const projectId of currentProjects) {
    let members = memberships.get(projectId);
    if (!members) {
      members = new Set();
      memberships.set(projectId, members);
    }
    if (!members.has(agentId)) {
      // Debounce: if this agent recently left this project, verify liveness
      // before accepting the rejoin. Stale wire restores create bindings for
      // agents that are no longer running, producing spurious join events.
      const leaveKey = `${agentId}:${projectId}`;
      const lastLeave = recentLeaves.get(leaveKey);
      // A group project whose members are a record (#3357) binds from the record, never a stale wire.
      if (recordDecidesMembers(projectId)) recentLeaves.delete(leaveKey);
      else if (lastLeave !== undefined && Date.now() - lastLeave < REJOIN_DEBOUNCE_MS) {
        if (!isAgentAlive(agentId)) {
          appLog('core:group-project', 'info', 'Suppressed spurious rejoin — agent not running', {
            meta: { agentId, projectId, msSinceLeave: Date.now() - lastLeave },
          });
          // Retract the stale binding so list_members stays accurate
          bindingManager.unbind(agentId, projectId);
          continue;
        }
        // Agent is alive — clear the debounce record and proceed
        recentLeaves.delete(leaveKey);
      }

      // Claim membership BEFORE the first await so that concurrent
      // syncMemberships calls (e.g. from rapid wire restoration or a
      // simultaneous binding update) cannot both pass the !members.has()
      // check and inject duplicate loop-start messages.
      members.add(agentId);

      const agentName = resolveAgentName(agentId);
      agentNames.set(agentId, agentName);

      // A membership restored at startup existed before this launch, so its
      // channels and inbox already exist. Track it, but post no join bulletin
      // and send no polling start (#1544). Channel seeding is skipped
      // too: it rewrites the board on every call.
      if (consumeRestoredBinding(agentId, projectId)) continue;

      // Fetch project info for name inclusion in messages
      let project: Awaited<ReturnType<typeof groupProjectRegistry.get>> | undefined;
      try {
        project = await groupProjectRegistry.get(projectId);
      } catch {
        // proceed with fallback name
      }
      const projectName = project?.name || projectId;

      try {
        // Retrofit: projects created before the channel-model redesign won't
        // have general/control seeded. Safe to call on every join — idempotent.
        await groupProjectHost.ensureChannels(projectId);
      } catch (err) {
        appLog('core:group-project', 'warn', 'Failed to ensure project channels on join', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
      }

      let inboxName: string | null = null;
      try {
        // Keyed by the member's address, so a second agent with the same name gets its own inbox (#1646).
        inboxName = await groupProjectHost.ensureInbox(projectId, agentName, agentId);
      } catch (err) {
        appLog('core:group-project', 'warn', 'Failed to create inbox channel', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
      }

      try {
        await groupProjectHost.post(projectId, 'system', 'system', `${agentName} joined project "${projectName}"`);
      } catch (err) {
        appLog('core:group-project', 'warn', 'Failed to post join event', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
      }

      // Auto-send polling instruction if polling is enabled
      if (project?.metadata?.pollingEnabled) {
        if (!canPoll(agentId)) {
          // Loaded here: group-project-polling imports this file.
          void import('./group-project-polling').then(({ holdPollingStart }) => holdPollingStart(agentId, projectId));
          continue;
        }
        const orchestrator = getAgentOrchestrator(agentId);
        // Small delay so the welcome message is processed first
        setTimeout(() => {
          injectPtyMessage(agentId, pollingStartMsg(projectName, orchestrator, inboxName));
          notePollingStart(agentId, projectId);
        }, 500);
      }
    }
  }
}

function resolveAgentName(agentId: string): string {
  // Look at all bindings to find the human-readable name for this agent
  const allBindings = bindingManager.getAllBindings();
  const binding = allBindings.find(b => b.agentId === agentId);
  return binding?.agentName || agentId;
}

/** For testing: reset state. */
export function _resetLifecycleForTesting(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  memberships.clear();
  agentNames.clear();
  recentLeaves.clear();
  initialized = false;
}

/** Exported for testing. */
export { REJOIN_DEBOUNCE_MS as _REJOIN_DEBOUNCE_MS_FOR_TESTING };
export { recentLeaves as _recentLeavesForTesting };
