/** Explicit local-user handshake recovery. No start, fallback, bridge or settings writes. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ChatHandshakeRetryResult } from '../../../shared/chat';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import { peekDurableConfigs } from '../agent-config';
import { peekProjects } from '../project-store';
import { isDispatcherPath } from '../dispatcher/dispatcher-paths';
import { agentRegistry } from '../agent-registry';
import { agentTransitionGeneration } from '../agent-transition';
import { resolveOrchestrator, resolveProfileEnv, resolveCommandPrefix } from '../agent-system';
import { resolveRuntimeMode } from '../chat-runtime-settings';
import { resolveChatDriver } from './chat-drivers';
import { chatLaunchEnvironment } from './chat-spawn';
import { binaryIdentity, driverHealthKey, probeDriver, recordDriverSuccess } from './chat-driver-health';
import { evaluateCliVersion } from './chat-version-policy';

async function context(projectPath: string, agentId: string) {
  if (!isDispatcherPath(projectPath) && !(await peekProjects()).some((p) => path.resolve(p.path) === path.resolve(projectPath))) throw new Error('Project is no longer registered.');
  const config = (await peekDurableConfigs(projectPath)).find((a) => a.id === agentId);
  if (!config || isDisposedAgent(config) || config.creation) throw new Error('Agent is unavailable for a handshake check.');
  const generation = agentTransitionGeneration(agentId);
  const cwd = config.worktreePath || projectPath;
  const provider = await resolveOrchestrator(projectPath, config.orchestrator);
  const active = agentRegistry.get(agentId);
  if (active && (active.projectPath !== projectPath || active.orchestrator !== provider.id || (active.cwd && path.resolve(active.cwd) !== path.resolve(cwd)))) throw new Error('Agent target changed. Refresh before checking again.');
  const mode = resolveRuntimeMode(provider.id, config.runtimeMode);
  if (mode.mode !== 'chat') throw new Error('Chat is off for this agent. No handshake was requested.');
  const driver = resolveChatDriver(provider.id, mode.driver);
  if (!driver || !provider.getBinaryPath) throw new Error('No registered chat driver or CLI binary is available.');
  const binary = provider.getBinaryPath();
  const identity = binaryIdentity(binary);
  if (identity === undefined) throw new Error('The selected CLI binary could not be inspected. Check its installation.');
  const env = chatLaunchEnvironment(await resolveProfileEnv(projectPath, provider.id));
  const prefix = await resolveCommandPrefix(projectPath);
  const key = driverHealthKey(driver, binary, env, prefix);
  const fingerprint = createHash('sha256').update(JSON.stringify([projectPath, agentId, cwd, provider.id, mode, generation, key, identity, active])).digest('hex');
  return { driver, binary, env, prefix, key, fingerprint };
}

export async function retryAgentHandshake(projectPath: string, agentId: string): Promise<ChatHandshakeRetryResult> {
  let selected: Awaited<ReturnType<typeof context>>;
  try { selected = await context(projectPath, agentId); } catch (err) {
    return { status: 'cannot_probe', message: err instanceof Error ? err.message : 'Could not resolve this handshake target.' };
  }
  const stillCurrent = async () => {
    try { const fresh = await context(projectPath, agentId); return fresh.fingerprint === selected.fingerprint && fresh.driver === selected.driver; }
    catch { return false; /* telemetry-exempt: explicitly returned as stale; never readiness */ }
  };
  const stale = (): ChatHandshakeRetryResult => ({ status: 'stale', message: 'The agent or launch settings changed. This result does not apply; check again.' });
  // Check after all asynchronous launch resolution, immediately before dispatch.
  if (!await stillCurrent()) return stale();
  const result = await probeDriver(selected.driver, selected.binary, selected.env, selected.prefix, { fresh: true, cacheSuccess: false });
  if (!await stillCurrent()) return stale();
  const base = { driver: selected.driver.id, cliVersion: result.cliVersion, contextId: selected.fingerprint };
  if (!result.handshakeOk) return { ...base, status: 'failed', message: `Handshake failed: ${result.error || 'no response'}. Check the CLI and Command prefix, repair them, then check again.` };
  if (result.needsLogin) return { ...base, status: 'login_required', message: result.loginHint || 'The CLI needs a login. Sign in using its own flow, then check again.' };
  const policy = evaluateCliVersion(selected.driver.id, selected.driver.provider, result.cliVersion);
  if (policy.status === 'known_bad' || policy.status === 'below_min') return { ...base, status: 'policy_blocked', message: policy.message || 'This CLI version is blocked for chat.' };
  recordDriverSuccess(selected.key);
  return { ...base, status: 'passed', message: 'Handshake passed for this check. No session or model request was made. Start the agent separately; login, tools and model access are not verified.' };
}
