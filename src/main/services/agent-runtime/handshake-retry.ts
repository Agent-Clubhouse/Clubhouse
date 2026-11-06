/** Explicit local-user handshake recovery. No start, fallback, bridge or settings writes. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { getBaseDirPath } from '../base-dir';
import { getSettings as profileSettings } from '../profile-settings';
import { projectSettingsMutationState } from '../agent-settings-service';
import * as path from 'node:path';
import type { ChatHandshakeRetryResult } from '../../../shared/chat';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import { agentConfigGeneration, peekDurableConfigs } from '../agent-config';
import { projectRegistryMutationState, peekProjects } from '../project-store';
import { isDispatcherPath } from '../dispatcher/dispatcher-paths';
import { agentRegistry } from '../agent-registry';
import { agentTransitionGeneration } from '../agent-transition';
import { resolveOrchestrator, resolveProfileEnv, resolveCommandPrefix } from '../agent-system';
import { resolveRuntimeMode } from '../chat-runtime-settings';
import { resolveChatDriver } from './chat-drivers';
import { chatLaunchEnvironment } from './chat-spawn';
import { binaryIdentity, driverHealthKey, probeDriver, recordDriverSuccess } from './chat-driver-health';
import { evaluateCliVersion } from './chat-version-policy';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
function fileWitness(file: string): string {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new RetryContextError('Launch settings could not be inspected. Refresh before checking.');
  }
}

class RetryContextError extends Error {}

async function context(projectPath: string, agentId: string) {
  const mutationWitness = () => [projectRegistryMutationState(), projectSettingsMutationState(projectPath)];
  if (mutationWitness().some((m) => m.pending)) throw new RetryContextError('Project settings are changing. Wait and check again.');
  const versions = hash(mutationWitness());
  // Known input files only. These observe external edits, not OS-level atomicity.
  const inputFiles = () => hash([
    ...['settings.json', 'settings.json.bak', 'agents.json', 'agents.json.bak'].map((name) => fileWitness(path.join(projectPath, '.clubhouse', name))),
    ...['projects.json', 'projects.json.bak'].map((name) => fileWitness(path.join(getBaseDirPath(), name))),
  ]);
  const files = inputFiles();
  const configVersion = agentConfigGeneration();
  const transition = agentTransitionGeneration(agentId);
  const profiles = hash(profileSettings());
  if (!isDispatcherPath(projectPath) && !(await peekProjects()).some((p) => path.resolve(p.path) === path.resolve(projectPath))) throw new RetryContextError('Project is no longer registered.');
  const config = (await peekDurableConfigs(projectPath)).find((a) => a.id === agentId);
  if (!config || isDisposedAgent(config) || config.creation) throw new RetryContextError('Agent is unavailable for a handshake check.');
  const generation = transition;
  const cwd = config.worktreePath || projectPath;
  const provider = await resolveOrchestrator(projectPath, config.orchestrator);
  const active = agentRegistry.get(agentId);
  if (active && (active.projectPath !== projectPath || active.orchestrator !== provider.id || (active.cwd && path.resolve(active.cwd) !== path.resolve(cwd)))) throw new RetryContextError('Agent target changed. Refresh before checking again.');
  const mode = resolveRuntimeMode(provider.id, config.runtimeMode);
  if (mode.mode !== 'chat') throw new RetryContextError('Chat is off for this agent. No handshake was requested.');
  const driver = resolveChatDriver(provider.id, mode.driver);
  if (!driver || !provider.getBinaryPath) throw new RetryContextError('No registered chat driver or CLI binary is available.');
  const binary = provider.getBinaryPath();
  const identity = binaryIdentity(binary);
  if (identity === undefined) throw new RetryContextError('The selected CLI binary could not be inspected. Check its installation.');
  const profileEnv = await resolveProfileEnv(projectPath, provider.id);
  const env = chatLaunchEnvironment(profileEnv);
  const prefix = await resolveCommandPrefix(projectPath);
  const key = driverHealthKey(driver, binary, env, prefix);
  const modeKey = hash(mode);
  const activeKey = hash(active);
  const valid = () => {
    try {
      const currentMode = resolveRuntimeMode(provider.id, config.runtimeMode);
      return !mutationWitness().some((m) => m.pending) && hash(mutationWitness()) === versions
      && agentConfigGeneration() === configVersion && agentTransitionGeneration(agentId) === transition
      && inputFiles() === files && hash(profileSettings()) === profiles
      && hash(agentRegistry.get(agentId)) === activeKey
      && hash(currentMode) === modeKey && resolveChatDriver(provider.id, currentMode.driver) === driver
      && provider.getBinaryPath?.() === binary && binaryIdentity(binary) === identity
      && hash(chatLaunchEnvironment(profileEnv)) === hash(env);
    } catch { return false; /* telemetry-exempt: stale receipt, never readiness */ }
  };
  // No await between this live-state check and returning the dispatch witness.
  if (!valid()) throw new RetryContextError('Launch settings changed while resolving this check.');
  const fingerprint = hash([projectPath, agentId, cwd, provider.id, mode, generation, configVersion, versions, files, profiles, key, identity, active]);
  return { driver, binary, env, prefix, key, fingerprint, valid };
}

export async function retryAgentHandshake(projectPath: string, agentId: string): Promise<ChatHandshakeRetryResult> {
  let selected: Awaited<ReturnType<typeof context>>;
  try { selected = await context(projectPath, agentId); } catch (err) {
    return { status: 'cannot_probe', message: err instanceof RetryContextError ? err.message : 'Could not resolve the selected CLI. Check its installation and launch settings.' };
  }
  const stillCurrent = async () => {
    try { const fresh = await context(projectPath, agentId); return fresh.valid() && selected.valid() && fresh.fingerprint === selected.fingerprint && fresh.driver === selected.driver; }
    catch { return false; /* telemetry-exempt: explicitly returned as stale; never readiness */ }
  };
  const stale = (): ChatHandshakeRetryResult => ({ status: 'stale', message: 'The agent or launch settings changed. This result does not apply; check again.' });
  // Check after all asynchronous launch resolution, immediately before dispatch.
  if (!await stillCurrent() || !selected.valid()) return stale();
  const result = await probeDriver(selected.driver, selected.binary, selected.env, selected.prefix, { fresh: true, cacheSuccess: false });
  if (!await stillCurrent() || !selected.valid()) return stale();
  const base = { driver: selected.driver.id, cliVersion: result.cliVersion && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(result.cliVersion) && result.cliVersion.length <= 80 ? result.cliVersion : undefined, contextId: selected.fingerprint };
  if (!result.handshakeOk) return { ...base, status: 'failed', message: 'Handshake failed. Check the CLI and Command prefix, repair them, then check again. Details remain in the local app log.' };
  if (result.needsLogin) return { ...base, status: 'login_required', message: 'The CLI needs a login. Sign in using its own flow, then check again.' };
  const policy = evaluateCliVersion(selected.driver.id, selected.driver.provider, result.cliVersion);
  if (policy.status === 'known_bad' || policy.status === 'below_min') return { ...base, status: 'policy_blocked', message: policy.message || 'This CLI version is blocked for chat.' };
  recordDriverSuccess(selected.key);
  return { ...base, status: 'passed', message: 'Handshake passed for this check. No session or model request was made. Start the agent separately; login, tools and model access are not verified.' };
}
