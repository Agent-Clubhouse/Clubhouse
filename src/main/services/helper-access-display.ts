/** Read-only recorded helper ceiling; no saved-provider/default inference or launch/control resolver. */
import * as path from 'path';
import { isAccessLevel as isFiveLevel } from '../../shared/agent-access';
import { isAccessLevel, resolveHelperAccess, type OrchestrationAccess } from '../../shared/orchestration-policy';
import { accessNote } from '../../shared/helper-policy-display';
import { agentRegistry } from './agent-registry';
import { getAgentRuntime } from './agent-runtime';
import { isAgentRunning } from './agent-system';
import type { DisplayValue, DisplayReceipt } from './display-settings';

const text = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 2048;
const samePath = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** The note has the same policy calculation as the local card. It describes a
 * Clubhouse record observed now, not independent proof of provider enforcement. */
export function readHelperAccessNoteForDisplay(agentId: string, projectPath: string, name: string, access: DisplayValue<OrchestrationAccess>, options: { receipts?: DisplayReceipt[] } = {}): DisplayValue<string> {
  const read = () => {
    const live = isAgentRunning(agentId), registration = agentRegistry.get(agentId);
    // PTY resolvers return a new facade each time. Their stable registration
    // and authenticated nonce, not facade equality, bind the recorded run.
    const runtime = registration?.runtime === 'chat' ? getAgentRuntime(agentId) : undefined;
    const runId = runtime?.kind === 'chat' ? runtime.getDisplayRunId?.() : undefined;
    const session = runtime?.kind === 'chat' ? runtime.getSessionId?.() : undefined;
    const native = runtime?.kind === 'chat' ? runtime.getNativeSessionId?.() : undefined;
    const inputs = [{ field: 'Observed Clubhouse helper access record', source: 'host-cache' as const, observedAt: Date.now() }];
    const unknown = (): DisplayValue<string> => ({ state: 'unavailable', inputs });
    let value: DisplayValue<string> = unknown();
    const raw = registration?.launchAccess;
    // Project/run identity and every field used by the pure local calculation
    // must be positively known. Missing high-access mode is not Ask first.
    const valid = raw && typeof raw.freeAgentMode === 'boolean'
      && (raw.permissionMode === undefined || raw.permissionMode === 'auto' || raw.permissionMode === 'skip-all')
      && (!raw.freeAgentMode || raw.permissionMode !== undefined)
      && (raw.access === undefined || isFiveLevel(raw.access))
      && (raw.access === undefined || (raw.access === 'full_access' ? raw.freeAgentMode && raw.permissionMode === 'skip-all'
        : raw.access === 'auto' ? raw.freeAgentMode && raw.permissionMode === 'auto' : !raw.freeAgentMode));
    const launch = valid && raw ? { freeAgentMode: raw.freeAgentMode, permissionMode: raw.permissionMode, ...(raw.access && { access: raw.access }) } : undefined;
    if (!live) value = { state: 'ok', value: accessNote(null, false, name), inputs };
    else if (access.state === 'ok' && (access.value === 'same' || isAccessLevel(access.value)) && registration
      && text(registration.nonce) && text(registration.orchestrator) && text(registration.projectPath) && samePath(registration.projectPath, projectPath)
      && ['pty', 'headless', 'chat'].includes(registration.runtime) && launch
      && (registration.runtime !== 'chat' || runtime?.kind === 'chat' && text(runId) && text(session))) {
      value = { state: 'ok', value: accessNote(resolveHelperAccess(launch, access.value, registration.orchestrator), true, name), inputs };
    }
    return { live, registration, nonce: registration?.nonce, provider: registration?.orchestrator, project: registration?.projectPath,
      cwd: registration?.cwd, kind: registration?.runtime, runtime, runId, session, native, launch: JSON.stringify(launch), value };
  };
  const admitted = read();
  options.receipts?.push({ current: () => { try {
    const now = read();
    return now.live === admitted.live && now.registration === admitted.registration && now.nonce === admitted.nonce && now.provider === admitted.provider
      && now.project === admitted.project && now.cwd === admitted.cwd && now.kind === admitted.kind && now.runtime === admitted.runtime
      && now.runId === admitted.runId && now.session === admitted.session && now.native === admitted.native && now.launch === admitted.launch
      && now.value.state === admitted.value.state && (now.value.state !== 'ok' || admitted.value.state === 'ok' && now.value.value === admitted.value.value);
  } catch { return false; } } });
  return admitted.value;
}
