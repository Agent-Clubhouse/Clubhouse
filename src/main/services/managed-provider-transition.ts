/** Managed native-instruction preparation for guided provider changes (#3731).
 * This is not a running-delivery receipt. The supported lane has no skills;
 * MCPs arrive through the existing Codex launch-argument path at start.
 * No existing file is overwritten, moved or adopted by this transaction. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as sync from 'node:fs';
import * as path from 'node:path';
import type { DurableAgentConfig, ManagedProviderTransition } from '../../shared/types';
import type { OrchestratorProvider } from '../orchestrators/types';
import { MobileControlError } from './mobile-control';
import { instructionsFileRel, managedGrantedSkillIds, renderManagedInstructions, resolveManagedSetup } from './managed-agents/delivery';
import { assetCatalogDir } from './asset-catalog/store';
import { resolveRuntimeMode } from './chat-runtime-settings';
import { readLaunchWrapper, readProjectAgentDefaults } from './agent-settings-service';
import { readProviderSelectionCatalog, resolveProviderSelectionCatalog } from './provider-selection-catalog';
import { agentRegistry } from './agent-registry';

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const refuse = (code: string): never => { throw new MobileControlError(code); };
const MAX_BYTES = 2 * 1024 * 1024;
interface FileState { dev: number; ino: number; size: number; mtime: number; ctime: number; mode: number; text: string }
interface RootState { real: string; dev: number; ino: number }
export interface ManagedProviderPlan {
  fingerprint: string;
  blocked: string | null;
  root: RootState;
  sourcePath: string;
  targetPath: string;
  source: FileState | null;
  target: FileState | null;
  instructions: string;
  composition: string;
  launchFingerprint: string;
  catalogFiles: string[];
  catalogEvidence: string[];
}
function fileStateSync(file: string): FileState | null {
  let fd: number | undefined;
  try {
    fd = sync.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = sync.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return refuse('managed_instructions_unreadable');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const size = sync.readSync(fd, bytes, 0, bytes.length, 0);
    const after = sync.fstatSync(fd);
    const named = sync.lstatSync(file);
    if (named.isSymbolicLink() || st.dev !== named.dev || st.ino !== named.ino || st.size !== size || after.size !== size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) return refuse('stale_state');
    return { dev: st.dev, ino: st.ino, size, mtime: st.mtimeMs, ctime: st.ctimeMs, mode: st.mode, text: bytes.subarray(0, size).toString('utf8') };
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  finally { if (fd !== undefined) sync.closeSync(fd); }
}
function rootStateSync(cwd: string): RootState {
  const st = sync.lstatSync(cwd);
  if (!st.isDirectory() || st.isSymbolicLink()) return refuse('managed_workspace_unsupported');
  return { real: sync.realpathSync(cwd), dev: st.dev, ino: st.ino };
}
/** Unknown/unreadable never means empty. No skills directory is created. */
function assertNoAmbientSkills(root: string): void {
  for (const rel of ['.agents/skills', '.codex/skills']) {
    let at = root;
    for (const part of rel.split('/')) {
      at = path.join(at, part);
      try {
        const st = sync.lstatSync(at);
        if (!st.isDirectory() || st.isSymbolicLink()) return refuse('managed_delivery_unsupported');
      } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') break; throw err; }
    }
    try { if (sync.readdirSync(path.join(root, rel)).length) return refuse('managed_delivery_unsupported'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  if (fileStateSync(path.join(root, 'AGENTS.override.md'))) return refuse('managed_delivery_unsupported');
}
function launchSettingsEvidence(projectPath: string): string {
  // Existing forgiving settings readers cannot distinguish unreadable from absent.
  const file = fileStateSync(path.join(projectPath, '.clubhouse', 'settings.json'));
  const raw = file ? JSON.parse(file.text) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.launchWrapper || raw.agentDefaults?.commandPrefix) return refuse('managed_delivery_unsupported');
  return digest([file, file ? null : fileStateSync(path.join(projectPath, '.clubhouse', 'settings.json.bak'))]);
}
function nativeFingerprint(root: RootState, target: FileState | null) { return digest([root, target]); }
function assertIsolated(rows: readonly DurableAgentConfig[], root: RootState, agentId: string): void {
  const peers = [...rows.filter((row) => row.id !== agentId).flatMap((row) => row.worktreePath ? [row.worktreePath] : []),
    ...[...agentRegistry.getAllRegistrations()].filter(([id]) => id !== agentId).flatMap(([, row]) => row.cwd ? [row.cwd] : [])];
  for (const peer of peers) {
    try { if (sync.realpathSync(peer) === root.real) return refuse('managed_workspace_shared'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
}
function nativeSettingsEvidence(root: string): string {
  const dir = path.join(root, '.codex');
  try { const st = sync.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return refuse('managed_delivery_unsupported'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  return digest([fileStateSync(path.join(dir, 'config.toml')), fileStateSync(path.join(dir, 'hooks.json'))]);
}
function assertReadOnlyLane(projectPath: string, agent: DurableAgentConfig, provider: OrchestratorProvider, resolved: Awaited<ReturnType<typeof resolveManagedSetup>>, root: RootState): void {
  if (provider.id !== 'codex-cli' || provider.conventions.settingsFormat !== 'toml' || !provider.buildMcpArgs
    || resolved.skills.length || resolved.missing.length || resolved.mcps.some((m) => m.droppedEnvValues.length)
    || resolveRuntimeMode(provider.id, agent.runtimeMode).mode !== 'terminal'
    || agent.contextWindow || agent.agentFile || agent.agentSource) return refuse('managed_delivery_unsupported');
  assertNoAmbientSkills(root.real);
  launchSettingsEvidence(projectPath);
}
async function rootState(cwd: string): Promise<RootState> {
  const st = await fs.lstat(cwd);
  if (!st.isDirectory() || st.isSymbolicLink()) return refuse('managed_workspace_unsupported');
  return { real: await fs.realpath(cwd), dev: st.dev, ino: st.ino };
}
/** Plain files only; distinguish absent from empty, and bind identity as well as bytes. */
async function readFile(file: string): Promise<FileState | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_BYTES) return refuse('managed_instructions_unreadable');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await handle.stat();
    if (used > MAX_BYTES || after.size !== used || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) return refuse('stale_state');
    const named = await fs.lstat(file);
    if (named.isSymbolicLink() || named.dev !== st.dev || named.ino !== st.ino) return refuse('stale_state');
    return { dev: st.dev, ino: st.ino, size: used, mtime: st.mtimeMs, ctime: st.ctimeMs, mode: st.mode, text: bytes.subarray(0, used).toString('utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  } finally { await handle?.close(); }
}
export async function previewManagedProviderTransition(projectPath: string, agent: DurableAgentConfig, current: OrchestratorProvider, provider: OrchestratorProvider): Promise<ManagedProviderPlan> {
  if (!agent.managed || !agent.worktreePath || path.resolve(agent.worktreePath) === path.resolve(projectPath)) return refuse('managed_workspace_unsupported');
  const sourceRel = instructionsFileRel(current);
  const targetRel = instructionsFileRel(provider);
  // Nested native instruction paths need a separate directory transaction.
  if (path.basename(sourceRel) !== sourceRel || path.basename(targetRel) !== targetRel) return refuse('managed_transition_unsupported');
  const root = await rootState(agent.worktreePath);
  const { peekDurableConfigsChecked } = await import('./agent-config');
  const inventory = await peekDurableConfigsChecked(projectPath, { strict: true });
  if (!inventory.readable) return refuse('managed_workspace_unverified');
  assertIsolated(inventory.agents, root, agent.id);
  const sourcePath = path.join(root.real, sourceRel);
  const targetPath = path.join(root.real, targetRel);
  const { managedAgents } = await import('./managed-agents');
  const resolved = await resolveManagedSetup(managedAgents(), agent.managed, agent);
  assertReadOnlyLane(projectPath, current.id === provider.id ? agent : { ...agent, contextWindow: undefined }, provider, resolved, root);
  const instructions = await renderManagedInstructions(projectPath, agent, resolved);
  const composition = digest(resolved);
  const catalogFiles = [path.join(assetCatalogDir(), 'catalog.json'), ...[...resolved.blocks, ...resolved.skills, ...resolved.mcps].map((p) => path.join(assetCatalogDir(), 'revisions', p.id, `${p.revision}.json`))];
  const catalogEvidence = catalogFiles.map((file) => digest(fileStateSync(file)));
  const [source, target] = await Promise.all([readFile(sourcePath), readFile(targetPath)]);
  const blocked = agent.providerTransition && current.id === provider.id
    && (agent.providerTransition.composition !== composition || agent.providerTransition.nativeFingerprint !== nativeFingerprint(root, target)) ? 'managed_transition_stale'
    : resolved.missing.length ? 'managed_parts_missing'
    : source?.text !== instructions ? 'managed_source_conflict'
      : target !== null && target.text !== instructions ? 'managed_target_conflict' : null;
  const launchFingerprint = digest([launchSettingsEvidence(projectPath), nativeSettingsEvidence(root.real)]);
  const fingerprint = digest({ root, sourceRel, targetRel, source, target, composition, instructions, blocked, launchFingerprint, catalogEvidence });
  return { fingerprint, blocked, root, sourcePath, targetPath, source, target, composition, instructions, launchFingerprint, catalogFiles, catalogEvidence };
}

export function providerSettingsCommitFence(projectPath: string): () => void {
  const witness = launchSettingsEvidence(projectPath);
  return () => { if (launchSettingsEvidence(projectPath) !== witness) return refuse('stale_state'); };
}
export function managedProviderCommitFence(projectPath: string, plan: ManagedProviderPlan): (agent: DurableAgentConfig) => void {
  return (agent) => {
    if (managedGrantedSkillIds(agent).length || agent.managed?.skills.length) return refuse('stale_state');
    const primary = fileStateSync(path.join(projectPath, '.clubhouse', 'agents.json'));
    const rows: unknown = primary ? JSON.parse(primary.text) : null;
    if (!Array.isArray(rows)) return refuse('managed_workspace_unverified');
    assertIsolated(rows, plan.root, agent.id);
    const matches = rows.filter((row) => row && typeof row === 'object' && row.id === agent.id);
    const withoutSleep = (row: DurableAgentConfig) => { const copy = { ...row }; delete copy.lastSleep; return copy; };
    if (matches.length !== 1 || digest(withoutSleep(matches[0])) !== digest(withoutSleep(agent))) return refuse('stale_state');
    assertNoAmbientSkills(plan.root.real);
    if (digest(rootStateSync(plan.root.real)) !== digest(plan.root) || digest(fileStateSync(plan.sourcePath)) !== digest(plan.source)
      || digest(fileStateSync(plan.targetPath)) !== digest(plan.target)
      || digest([launchSettingsEvidence(projectPath), nativeSettingsEvidence(plan.root.real)]) !== plan.launchFingerprint
      || plan.catalogFiles.some((file, i) => digest(fileStateSync(file)) !== plan.catalogEvidence[i])) return refuse('stale_state');
  };
}

export function managedProviderMarker(agentId: string, plan: ManagedProviderPlan): ManagedProviderTransition {
  if (!plan.target || plan.target.text !== plan.instructions || plan.blocked) return refuse('managed_instructions_unprepared');
  return { version: 2, agentId, provider: 'codex-cli', delivery: 'read_only_managed', composition: plan.composition, nativeFingerprint: nativeFingerprint(plan.root, plan.target) };
}

/** Every start/resume/restart reaches this before legacy cleanup. No native
 * managed output is written. A synchronous closure rechecks evidence at the
 * actual PTY creation boundary, after cwd and command preparation awaits. */
export async function managedProviderStartGuard(projectPath: string, agent: DurableAgentConfig, provider: OrchestratorProvider, cwd: string, current: () => Readonly<DurableAgentConfig> | null): Promise<() => void> {
  const marker = agent.providerTransition;
  if (!marker || marker.version !== 2 || marker.agentId !== agent.id || marker.provider !== provider.id || marker.delivery !== 'read_only_managed'
    || agent.orchestrator !== provider.id || !agent.managed || !agent.worktreePath || path.resolve(cwd) !== path.resolve(agent.worktreePath)) return refuse('managed_transition_stale');
  const root = await rootState(cwd);
  if (root.real === await fs.realpath(projectPath)) return refuse('managed_workspace_unsupported');
  const catalogPath = path.join(assetCatalogDir(), 'catalog.json');
  const catalogBefore = digest(fileStateSync(catalogPath));
  const { managedAgents } = await import('./managed-agents');
  const settings = launchSettingsEvidence(projectPath);
  const nativeSettings = nativeSettingsEvidence(root.real);
  await readProjectAgentDefaults(projectPath, { strict: true });
  await readLaunchWrapper(projectPath, { strict: true });
  if (launchSettingsEvidence(projectPath) !== settings) return refuse('managed_transition_stale');
  const resolved = await resolveManagedSetup(managedAgents(), agent.managed, agent);
  assertReadOnlyLane(projectPath, agent, provider, resolved, root);
  const text = await renderManagedInstructions(projectPath, agent, resolved);
  const targetPath = path.join(root.real, instructionsFileRel(provider));
  const target = await readFile(targetPath);
  if (target?.text !== text || digest(resolved) !== marker.composition || nativeFingerprint(root, target) !== marker.nativeFingerprint) return refuse('managed_transition_stale');
  const catalogFiles = [catalogPath, ...[...resolved.blocks, ...resolved.skills, ...resolved.mcps].map((p) => path.join(assetCatalogDir(), 'revisions', p.id, `${p.revision}.json`))];
  const catalogEvidence = catalogFiles.map((file) => digest(fileStateSync(file)));
  if (digest(fileStateSync(catalogPath)) !== catalogBefore) return refuse('managed_transition_stale');
  const resolvedAgain = await resolveManagedSetup(managedAgents(), agent.managed, agent);
  if (digest(resolvedAgain) !== marker.composition || catalogFiles.some((file, i) => digest(fileStateSync(file)) !== catalogEvidence[i])) return refuse('managed_transition_stale');
  const selection = await readProviderSelectionCatalog(provider, agent.model, agent.effort, !!agent.model);
  if (selection.blocked) return refuse(selection.blocked);
  const configFingerprint = (value: Readonly<DurableAgentConfig> | null) => {
    if (!value) return '';
    const copy = { ...value }; delete copy.lastSleep;
    return digest(copy);
  };
  const config = configFingerprint(agent);
  const savedConfig = () => {
    const raw = fileStateSync(path.join(projectPath, '.clubhouse', 'agents.json'));
    if (!raw) return null;
    const rows: unknown = JSON.parse(raw.text);
    if (!Array.isArray(rows)) return null;
    assertIsolated(rows, root, agent.id);
    const matches = rows.filter((row) => row && typeof row === 'object' && row.id === agent.id);
    return matches.length === 1 ? matches[0] as DurableAgentConfig : null;
  };
  if (configFingerprint(savedConfig()) !== config) return refuse('managed_transition_stale');
  return () => {
    const currentSelection = resolveProviderSelectionCatalog(provider.peekModels?.() ?? null, agent.model, agent.effort, !!agent.model);
    if (currentSelection.blocked || (provider.peekModels && currentSelection.fingerprint !== selection.fingerprint)) return refuse('managed_transition_stale');
    if (configFingerprint(current() ?? savedConfig()) !== config || configFingerprint(savedConfig()) !== config || digest(rootStateSync(cwd)) !== digest(root)
      || nativeFingerprint(rootStateSync(cwd), fileStateSync(targetPath)) !== marker.nativeFingerprint
      || managedGrantedSkillIds(agent).length || launchSettingsEvidence(projectPath) !== settings
      || nativeSettingsEvidence(root.real) !== nativeSettings
      || catalogFiles.some((file, index) => digest(fileStateSync(file)) !== catalogEvidence[index])
      || resolveRuntimeMode(provider.id, agent.runtimeMode).mode !== 'terminal') return refuse('managed_transition_stale');
    assertNoAmbientSkills(root.real);
  };
}

/** Prepare the absent file. The rejection callback reports retained/uncertain
 * bytes without unlinking a path a person could replace. Retry requires a
 * fresh preview; partial/custom bytes block it. */
export async function prepareManagedProviderTransition(plan: ManagedProviderPlan, assertCurrent: () => Promise<void>): Promise<() => Promise<void>> {
  await assertCurrent();
  if (plan.blocked) return refuse(plan.blocked);
  if (plan.target) return async () => {};
  let created: FileState | null = null;
  let createdByOperation = false;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const reportRetention = async () => {
    if (!createdByOperation) return;
    // Node exposes no atomic identity-conditional unlink. Retain even our own
    // inert bytes rather than deleting a person's late replacement via path.
    let unchanged = false;
    try {
      const now = await readFile(plan.targetPath);
      unchanged = !!created && digest(now) === digest(created) && digest(await rootState(plan.root.real)) === digest(plan.root);
    } catch { /* telemetry-exempt: failed observation cannot authorize cleanup or claim intact bytes. */ }
    throw new MobileControlError(unchanged ? 'managed_preparation_retained' : 'managed_rollback_conflict', 409, 'failed',
      'Native preparation may remain. Review the saved configuration and conflicts before retrying.',
      { transition: { nativePreparation: 'may_remain', completeness: 'unverified' } });
  };
  try {
    if (digest(await rootState(plan.root.real)) !== digest(plan.root)) return refuse('stale_state');
    handle = await fs.open(plan.targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    createdByOperation = true;
    // Capture partial writes too, so failure cannot leave a truncated target.
    try {
      await handle.writeFile(plan.instructions, 'utf8');
      await handle.sync();
    } finally {
      const st = await handle.stat();
      const bytes = Buffer.alloc(st.size);
      await handle.read(bytes, 0, bytes.length, 0);
      created = { dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, mode: st.mode, text: bytes.toString('utf8') };
      await handle.close(); handle = undefined;
    }
    if (digest(await readFile(plan.sourcePath)) !== digest(plan.source)) return refuse('stale_state');
    return reportRetention;
  } catch (err) {
    try { await handle?.close(); } catch { /* telemetry-exempt: preparation still gets an explicit retention receipt. */ }
    await reportRetention();
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return refuse('stale_state');
    throw err;
  }
}
