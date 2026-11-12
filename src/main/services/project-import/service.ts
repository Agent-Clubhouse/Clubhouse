import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Project } from '../../../shared/types';
import { checkProjectFolder, registerProjectFolder, type RegisterProjectResult } from '../project-add';
import * as projectStore from '../project-store';
import { getOriginUrl } from '../git-service';
import { appLog } from '../log-service';
import { createImportGit, type ImportGit } from './git';
import { ImportStore, IMPORT_HISTORY_MAX } from './store';
import {
  ACTIVE_PHASES, IMPORT_EFFECTS, ImportError, containsControlCharacters, directoryIdentity, validateGithubUrl, validateImportBranch,
  type ImportInput, type ImportPlan, type ImportReceipt,
} from './types';

const PLAN_TTL_MS = 10 * 60_000;

export type ImportAuthorization = (scope: Readonly<ImportPlan>) => Promise<
  { kind: 'approved'; assertCurrent: () => Promise<void> } | { kind: 'asked'; text: string }
>;

interface Dependencies {
  store: ImportStore;
  git: ImportGit;
  now: () => number;
  listProjects: () => Promise<Project[]>;
  origin: (folder: string) => Promise<string | null>;
  register: (folder: string) => Promise<RegisterProjectResult>;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function lstatOrMissing(folder: string): Promise<Awaited<ReturnType<typeof fsp.lstat>> | undefined> {
  try {
    return await fsp.lstat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ImportError('placement_unavailable', 'The destination cannot be inspected safely. Check folder permissions and preview again.');
  }
}

export class ProjectImportService {
  private readonly deps: Dependencies;
  private readonly running = new Map<string, { controller: AbortController; receipt: ImportReceipt }>();
  private starting = false;

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = {
      store: new ImportStore(), git: createImportGit(), now: Date.now,
      listProjects: projectStore.list, origin: getOriginUrl, register: registerProjectFolder,
      ...deps,
    };
  }

  private async placement(input: string): Promise<{ destination: string; parent: string; parentIdentity: string }> {
    if (!path.isAbsolute(input) || input.length > 4096 || containsControlCharacters(input)) {
      throw new ImportError('invalid_destination', 'Choose an explicit absolute destination, with an existing parent folder. Clubhouse does not choose a hidden import root.');
    }
    const resolved = path.resolve(input);
    if (resolved === path.parse(resolved).root || /(?:^|[\\/])\.clubhouse(?:-dev)?(?:[\\/]|$)/i.test(resolved)) {
      throw new ImportError('unsafe_destination', 'Choose a new project folder outside Clubhouse internal folders and agent worktrees.');
    }
    const parentCheck = await checkProjectFolder(path.dirname(resolved));
    if ('reason' in parentCheck) throw new ImportError('unsafe_destination', parentCheck.message);
    const parent = await fsp.realpath(parentCheck.path);
    const parentStat = await fsp.stat(parent);
    const destination = path.join(parent, path.basename(resolved));
    return { destination, parent, parentIdentity: directoryIdentity(parentStat) };
  }

  private async existingProject(url: string, destination: string): Promise<Project | undefined> {
    const projects = await this.deps.listProjects();
    for (const project of projects) {
      const canonical = await projectStore.canonicalProjectPath(project.path);
      if (projectStore.projectPathKey(canonical) === projectStore.projectPathKey(destination)) return project;
      if (inside(destination, canonical) || inside(canonical, destination)) {
        throw new ImportError('project_overlap', 'The chosen destination overlaps a registered project. Reuse that project or choose a separate new location.');
      }
      const origin = await this.deps.origin(project.path);
      if (origin && origin.toLowerCase().replace(/\.git$/, '') === url.toLowerCase().replace(/\.git$/, '')) return project;
    }
    return undefined;
  }

  async preview(agentId: string, input: ImportInput) {
    const url = validateGithubUrl(input.url);
    const requested = input.branch === undefined ? undefined : validateImportBranch(input.branch);
    const placement = await this.placement(input.destination);
    const existing = await this.existingProject(url, placement.destination);
    if (existing) {
      return {
        status: 'existing_project' as const, projectId: existing.id, destination: existing.path,
        message: 'A project already uses this repository or destination. Open/reuse it explicitly; no checkout, registration or agent change was made.',
        agentCreated: false, agentStarted: false,
      };
    }
    const state = await this.deps.store.get();
    const prior = state.receipts.find((r) => projectStore.projectPathKey(r.plan.destination) === projectStore.projectPathKey(placement.destination));
    if (prior) return { status: 'existing_import' as const, receipt: await this.status(agentId, prior.id) };
    if (await lstatOrMissing(placement.destination)) {
      throw new ImportError('destination_exists', 'The destination already exists, even if it is empty. Nothing was changed. Inspect and explicitly reuse it with add_project, or choose another new destination; imports never overwrite or delete it.');
    }
    const remote = await this.deps.git.remote(url, requested);
    const now = this.deps.now();
    let plan: ImportPlan = {
      ...remote, ...placement, id: randomUUID(), agentId,
      createdAt: now, expiresAt: now + PLAN_TTL_MS, effects: IMPORT_EFFECTS,
    };
    await this.deps.store.update((current) => {
      current.plans = current.plans.filter((p) => p.expiresAt > now || current.receipts.some((r) => r.plan.id === p.id));
      const same = current.plans.find((p) => p.agentId === agentId && p.url === plan.url && p.destination === plan.destination
        && p.parentIdentity === plan.parentIdentity && p.branch === plan.branch && p.commit === plan.commit
        && p.defaultBranch === plan.defaultBranch && p.headCommit === plan.headCommit && p.expiresAt > now);
      if (same) { plan = same; return; }
      if (current.plans.length >= IMPORT_HISTORY_MAX) throw new ImportError('history_limit', 'Too many import plans are retained. Nothing was cloned; let unused previews expire before trying again.');
      current.plans.push(plan);
    });
    return {
      status: 'ready' as const, plan,
      message: 'Preview only. The import needs exact current human approval in Needs you, including when project.add is set to Allow. No repository files or agents were created.',
      agentCreated: false, agentStarted: false,
    };
  }

  private async validateRemote(plan: ImportPlan, signal?: AbortSignal): Promise<void> {
    const remote = await this.deps.git.remote(plan.url, plan.branch, signal);
    if (remote.url !== plan.url || remote.branch !== plan.branch || remote.commit !== plan.commit
      || remote.defaultBranch !== plan.defaultBranch || remote.headCommit !== plan.headCommit) {
      throw new ImportError('remote_changed', 'Repository access, default branch or selected commit changed after preview. Preview again and obtain fresh human approval.');
    }
  }

  private async validate(plan: ImportPlan): Promise<void> {
    if (this.deps.now() >= plan.expiresAt) throw new ImportError('plan_expired', 'The preview expired. Preview again and obtain fresh approval; nothing was created.');
    if (validateGithubUrl(plan.url) !== plan.url) throw new ImportError('plan_changed', 'Repository identity changed. Preview and approve again.');
    const placement = await this.placement(plan.destination);
    if (placement.destination !== plan.destination || placement.parent !== plan.parent || placement.parentIdentity !== plan.parentIdentity) {
      throw new ImportError('placement_changed', 'The destination parent changed after preview. Preview and approve the new placement before importing.');
    }
    if (await this.existingProject(plan.url, plan.destination)) throw new ImportError('project_changed', 'A matching project appeared after preview. Open/reuse it instead; no import was started.');
    if (await lstatOrMissing(plan.destination)) throw new ImportError('destination_exists', 'The destination appeared after preview. Nothing was overwritten; inspect/reuse it or preview a different new location.');
    await this.validateRemote(plan);
  }

  async start(agentId: string, planId: string, destination: string, authorize: ImportAuthorization) {
    if (this.starting) throw new ImportError('import_busy', 'Another import is being validated. Wait for its result; no second checkout was started.');
    this.starting = true;
    try {
      const state = await this.deps.store.get();
      const prior = state.receipts.find((r) => r.plan.id === planId && r.plan.agentId === agentId);
      if (prior) return { status: 'existing_import' as const, receipt: await this.status(agentId, prior.id) };
      const plan = state.plans.find((p) => p.id === planId && p.agentId === agentId);
      if (!plan || plan.destination !== destination) throw new ImportError('plan_mismatch', 'Use your current preview id and its exact canonical destination. Changed inputs require a new preview and human approval.');
      if (this.running.size) throw new ImportError('import_busy', 'One bounded import is already running. Check or cancel it before starting another.');
      await this.validate(plan);
      const decision = await authorize(structuredClone(plan));
      if (decision.kind !== 'approved') return { status: 'approval_required' as const, message: decision.text };
      // Approval never substitutes for current filesystem, access and remote-identity checks.
      await this.validate(plan);
      await decision.assertCurrent();
      const receipt: ImportReceipt = {
        id: randomUUID(), plan, phase: 'reserved', updatedAt: this.deps.now(), cloneCompleted: false,
        agentCreated: false, agentStarted: false,
      };
      await this.deps.store.update((current) => {
        if (current.receipts.some((r) => r.plan.destination === destination)) throw new ImportError('destination_reserved', 'This destination already has an import receipt. Inspect/reuse that import; no duplicate checkout was started.');
        if (current.receipts.length >= IMPORT_HISTORY_MAX) throw new ImportError('history_limit', 'The bounded import history is full. Existing receipts and checkouts were preserved; no new checkout was started.');
        current.receipts.push(receipt);
      });
      const controller = new AbortController();
      this.running.set(receipt.id, { controller, receipt });
      void this.perform(receipt, controller, decision.assertCurrent).finally(() => { this.running.delete(receipt.id); });
      return { status: 'started' as const, receipt, message: 'Import is running. Read status for bounded progress or cancel this import id. Agent creation and start remain separate approvals.' };
    } finally {
      this.starting = false;
    }
  }

  private async save(receipt: ImportReceipt, phase: ImportReceipt['phase']): Promise<void> {
    receipt.phase = phase;
    receipt.updatedAt = this.deps.now();
    await this.deps.store.update((state) => {
      const index = state.receipts.findIndex((r) => r.id === receipt.id);
      if (index < 0) throw new ImportError('history_corrupt', 'The import receipt disappeared. Files were preserved; inspect before retrying.');
      state.receipts[index] = structuredClone(receipt);
    });
  }

  private async verifyOwned(receipt: ImportReceipt, initialized: boolean): Promise<void> {
    const parent = await fsp.realpath(receipt.plan.parent);
    const stat = await fsp.stat(parent);
    const target = await fsp.lstat(receipt.plan.destination);
    if (parent !== receipt.plan.parent || directoryIdentity(stat) !== receipt.plan.parentIdentity
      || target.isSymbolicLink() || !target.isDirectory() || directoryIdentity(target) !== receipt.directoryIdentity) {
      throw new ImportError('owned_directory_changed', 'The import directory or its parent was replaced. No further writes were attempted. Inspect the preserved state before reusing it.');
    }
    const gitDir = await lstatOrMissing(path.join(receipt.plan.destination, '.git'));
    const config = await lstatOrMissing(path.join(receipt.plan.destination, '.git', 'config'));
    if ((initialized && !gitDir) || (gitDir && (!gitDir.isDirectory() || gitDir.isSymbolicLink()))
      || (config && (!config.isFile() || config.isSymbolicLink()))) {
      throw new ImportError('owned_directory_changed', 'The import Git directory/configuration was replaced. No further writes were attempted; inspect the preserved state.');
    }
  }

  private async perform(receipt: ImportReceipt, controller: AbortController, assertCurrent: () => Promise<void>): Promise<void> {
    const { destination, url, branch, commit } = receipt.plan;
    const signal = controller.signal;
    let initialized = false;
    const checkpoint = async () => {
      signal.throwIfAborted();
      await assertCurrent();
      await this.verifyOwned(receipt, initialized);
    };
    const run = (args: string[]) => this.deps.git.run(args, {
      cwd: destination, signal,
      onProgress: (progress) => { receipt.progress = progress; },
    });
    try {
      signal.throwIfAborted();
      const currentPlacement = await this.placement(destination);
      if (currentPlacement.parentIdentity !== receipt.plan.parentIdentity || currentPlacement.destination !== destination) {
        throw new ImportError('placement_changed', 'The approved parent changed before directory creation. No checkout was started.');
      }
      await assertCurrent();
      // Exclusive creation is the final no-overwrite guard. An existing empty folder is not ours.
      await fsp.mkdir(destination);
      receipt.directoryIdentity = directoryIdentity(await fsp.lstat(destination));
      await this.save(receipt, 'initializing');
      await checkpoint();
      if ((await fsp.readdir(destination)).length) throw new ImportError('checkout_changed', 'Content appeared in the new import directory before initialization. It was preserved; inspect it before reusing this location.');
      await run(['init', '--quiet', '--template=', '--', '.']);
      initialized = true;
      await checkpoint();
      await run(['remote', 'add', '--', 'origin', url]);
      await this.save(receipt, 'fetching');
      await checkpoint();
      await run(['fetch', '--progress', '--no-tags', '--no-recurse-submodules', '--depth=1', '--', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      await checkpoint();
      const downloaded = (await run(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])).trim();
      if (downloaded !== commit) throw new ImportError('remote_changed', 'The branch changed while downloading. Objects were preserved but no checkout or registration was performed; preview again after inspecting the partial import.');
      await this.validateRemote(receipt.plan, signal);
      const rootNames = (await run(['ls-tree', '-z', '--name-only', commit])).split('\0');
      if (rootNames.some((name) => ['.clubhouse', '.clubhouse-dev'].includes(name.split(':')[0].replace(/[. ]+$/, '').toLowerCase()))) {
        throw new ImportError('repository_app_state', 'The repository contains Clubhouse runtime state. Downloaded objects are preserved but were not checked out or registered; inspect and remove repository-provided runtime state before importing.');
      }
      await this.save(receipt, 'checking_out');
      await checkpoint();
      await run(['checkout', '--no-recurse-submodules', '-b', branch, '--track', `origin/${branch}`, '--']);
      await checkpoint();
      receipt.cloneCompleted = true;
      await this.save(receipt, 'cloned');
      // Registration appends to .gitignore. Never follow a user-replaced symlink or special file.
      const ignore = await lstatOrMissing(path.join(destination, '.gitignore'));
      if (ignore && (!ignore.isFile() || ignore.isSymbolicLink())) throw new ImportError('unsafe_gitignore', 'Checkout finished, but .gitignore is not a regular file. It was not changed; inspect it before explicitly registering this checkout.');
      if (ignore && ignore.size > 1024 * 1024) throw new ImportError('gitignore_limit', 'Checkout finished, but .gitignore is too large for bounded registration. It was not changed; inspect it before explicit local registration.');
      if ((await run(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])).trim()) {
        throw new ImportError('checkout_changed', 'Checkout finished, but local files changed before registration. They were preserved; inspect the checkout and explicitly register it with add_project.');
      }
      await this.save(receipt, 'registering');
      await checkpoint();
      const result = await this.deps.register(destination);
      receipt.projectId = result.project.id;
      receipt.gitignore = result.gitignore;
      if (result.gitignore === 'failed') receipt.reason = 'gitignore_failed';
      await this.save(receipt, result.gitignore === 'failed' ? 'partial' : 'completed');
    } catch (error) {
      // telemetry-exempt: raw Git/credential/filesystem errors never leave this boundary.
      receipt.failedAt = receipt.phase;
      receipt.reason = signal.aborted ? 'cancelled' : error instanceof ImportError ? error.reason : 'operation_failed';
      const phase = signal.aborted ? 'cancelled' : receipt.cloneCompleted || receipt.projectId ? 'partial' : 'failed';
      appLog('core:project', 'warn', 'Bounded repository import did not fully complete', { meta: { importId: receipt.id, phase, reason: receipt.reason } });
      try {
        await this.save(receipt, phase);
      } catch {
        // telemetry-exempt: preserve the last durable stage; status reconciles registered projects after restart.
        receipt.reason = 'history_unavailable';
        receipt.phase = phase;
        appLog('core:project', 'warn', 'Import receipt could not be saved; preserved checkout must be inspected', { meta: { importId: receipt.id } });
      }
    }
  }

  async status(agentId: string, importId: string) {
    const active = this.running.get(importId);
    const stored = active?.receipt ?? (await this.deps.store.get()).receipts.find((r) => r.id === importId);
    if (!stored || stored.plan.agentId !== agentId) throw new ImportError('import_not_found', 'No import with that id belongs to this caller.');
    const receipt = structuredClone(stored);
    if (!active && ACTIVE_PHASES.has(receipt.phase)) {
      receipt.phase = 'interrupted';
      receipt.reason = 'app_interrupted';
      const project = (await this.deps.listProjects()).find((p) => projectStore.projectPathKey(p.path) === projectStore.projectPathKey(receipt.plan.destination));
      if (project) {
        receipt.projectId = project.id;
        receipt.reason = 'registration_receipt_interrupted';
        receipt.phase = 'partial';
      }
    }
    return {
      ...receipt,
      ...(receipt.reason === 'git_failed' && {
        message: 'Restore existing authorized GitHub/Git credential-helper access outside agent messages and check connectivity/repository access. Never send tokens or passwords here.',
      }),
      recovery: receipt.phase === 'completed'
        ? 'Open/reuse projectId. If requested, choose a managed-agent template/settings and obtain separate creation approval; wake it only under a separately approved start.'
        : active && ACTIVE_PHASES.has(receipt.phase)
          ? 'Read status or cancel only this import id. Cancellation preserves everything already created.'
          : receipt.projectId
            ? 'The project is registered: reuse projectId, do not clone again. Inspect the reported unfinished step. No agent was created or started.'
            : receipt.cloneCompleted
              ? 'The checkout is preserved. Inspect it, then explicitly register the same destination with add_project. Do not clone again, reset or delete it.'
              : 'Any partially created directory is preserved. Inspect it before explicitly reusing/registering it, or preview a different new destination. Never overwrite/delete it as incidental recovery.',
    };
  }

  async cancel(agentId: string, importId: string, destination: string) {
    const receipt = await this.status(agentId, importId);
    if (receipt.plan.destination !== destination) throw new ImportError('plan_mismatch', 'Cancellation must name the exact destination of your own import receipt.');
    const active = this.running.get(importId);
    if (!active || !ACTIVE_PHASES.has(active.receipt.phase)) return { status: 'not_running' as const, receipt };
    active.controller.abort();
    return { status: 'cancellation_requested' as const, receipt, message: 'Cancellation targets only this import\'s tracked Git child. Read status for the final outcome; files and completed project registration are preserved.' };
  }
}

export const projectImportService = new ProjectImportService();
