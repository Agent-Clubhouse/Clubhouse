/** Explicit local-user handshake recovery. No start, fallback, bridge or settings writes. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { getBaseDirPath } from '../base-dir';
import { projectSettingsMutationState } from '../agent-settings-service';
import * as path from 'node:path';
import type { ChatHandshakeRetryResult } from '../../../shared/chat';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import { agentConfigGeneration, peekDurableConfigs } from '../agent-config';
import { projectRegistryMutationState, peekProjects } from '../project-store';
import { isDispatcherPath } from '../dispatcher/dispatcher-paths';
import { agentRegistry } from '../agent-registry';
import { agentTransitionGeneration } from '../agent-transition';
import { resolveOrchestrator, resolveCommandPrefix } from '../agent-system';
import { resolveRuntimeMode } from '../chat-runtime-settings';
import { resolveChatDriver } from './chat-drivers';
import { chatLaunchEnvironment } from './chat-spawn';
import { binaryIdentity, driverHealthKey, probeDriver, recordDriverSuccess } from './chat-driver-health';
import { evaluateCliVersion } from './chat-version-policy';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export const MAX_HANDSHAKE_INPUT_BYTES = 4 * 1024 * 1024;
function fileWitness(file: string): string {
  let observed: fs.Stats;
  try { observed = fs.lstatSync(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new RetryContextError('Launch settings could not be inspected. Refresh before checking.');
  }
  let fd: number | undefined;
  try {
    if (!observed.isFile()) throw new RetryContextError('Launch settings must be regular files.');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(fd);
    if (before.dev !== observed.dev || before.ino !== observed.ino) throw new RetryContextError('Launch settings were replaced during inspection.');
    if (!before.isFile() || before.size > MAX_HANDSHAKE_INPUT_BYTES) throw new RetryContextError('Launch settings are not regular files or exceed the inspection limit.');
    // A bounded read also detects growth after fstat without reading unbounded bytes.
    const buffer = Buffer.alloc(before.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!n) break;
      bytes += n;
    }
    const after = fs.fstatSync(fd);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new RetryContextError('Launch settings changed during inspection.');
    return createHash('sha256').update(buffer.subarray(0, bytes)).digest('hex');
  } catch (err) {
    throw err instanceof RetryContextError ? err : new RetryContextError('Launch settings could not be inspected. Refresh before checking.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

class RetryContextError extends Error {}

async function context(requestedProjectPath: string, agentId: string) {
  const registryVersion = projectRegistryMutationState();
  if (registryVersion.pending) throw new RetryContextError('Project settings are changing. Wait and check again.');
  const registryFiles = () => hash(['projects.json', 'projects.json.bak'].map((name) => fileWitness(path.join(getBaseDirPath(), name))));
  const registryBytes = registryFiles();
  const registered = (await peekProjects()).find((p) => path.resolve(p.path) === path.resolve(requestedProjectPath));
  if (!registered && !isDispatcherPath(requestedProjectPath)) throw new RetryContextError('Project is no longer registered.');
  if (hash(projectRegistryMutationState()) !== hash(registryVersion) || registryFiles() !== registryBytes) throw new RetryContextError('Project registration changed while resolving this check.');
  const projectPath = path.resolve(registered?.path ?? requestedProjectPath);
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
  const config = (await peekDurableConfigs(projectPath)).find((a) => a.id === agentId);
  if (!config || isDisposedAgent(config) || config.creation) throw new RetryContextError('Agent is unavailable for a handshake check.');
  const generation = transition;
  const cwd = config.worktreePath || projectPath;
  const provider = await resolveOrchestrator(projectPath, config.orchestrator);
  const active = agentRegistry.get(agentId);
  if (active && (path.resolve(active.projectPath) !== projectPath || active.orchestrator !== provider.id || (active.cwd && path.resolve(active.cwd) !== path.resolve(cwd)))) throw new RetryContextError('Agent target changed. Refresh before checking again.');
  const mode = resolveRuntimeMode(provider.id, config.runtimeMode);
  if (mode.mode !== 'chat') throw new RetryContextError('Chat is off for this agent. No handshake was requested.');
  const driver = resolveChatDriver(provider.id, mode.driver);
  if (!driver || !provider.getBinaryPath) throw new RetryContextError('No registered chat driver or CLI binary is available.');
  const binary = provider.getBinaryPath();
  const identity = binaryIdentity(binary);
  if (identity === undefined) throw new RetryContextError('The selected CLI binary could not be inspected. Check its installation.');
  const env = chatLaunchEnvironment();
  const prefix = await resolveCommandPrefix(projectPath);
  const key = driverHealthKey(driver, binary, env, prefix);
  const modeKey = hash(mode);
  const activeKey = hash(active);
  const valid = () => {
    try {
      const currentMode = resolveRuntimeMode(provider.id, config.runtimeMode);
      return !mutationWitness().some((m) => m.pending) && hash(mutationWitness()) === versions
      && agentConfigGeneration() === configVersion && agentTransitionGeneration(agentId) === transition
      && inputFiles() === files
      && hash(agentRegistry.get(agentId)) === activeKey
      && hash(currentMode) === modeKey && resolveChatDriver(provider.id, currentMode.driver) === driver
      && provider.getBinaryPath?.() === binary && binaryIdentity(binary) === identity
      && hash(chatLaunchEnvironment()) === hash(env);
    } catch { return false; /* telemetry-exempt: stale receipt, never readiness */ }
  };
  // No await between this live-state check and returning the dispatch witness.
  if (!valid()) throw new RetryContextError('Launch settings changed while resolving this check.');
  const fingerprint = hash([projectPath, agentId, cwd, provider.id, mode, generation, configVersion, versions, files, key, identity, active]);
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
