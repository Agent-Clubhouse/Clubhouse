import { createHash, randomUUID } from 'crypto';
import { isSafeHandoffPath } from '../../shared/handoff-manifest';
import { safeHandoffDiagnosticPath, scanHandoffSecrets, type HandoffSecretFinding } from '../../shared/handoff-secrets';
import { HANDOFF_SECRET_MAX_PATHS, HANDOFF_SECRET_MAX_SETTING_BYTES, type HandoffSecretSettings } from '../../shared/handoff-secret-settings';
import { createSettingsStore, type SettingsStore } from './settings-store';
import { auditChanged, currentSettingsOrigin } from './settings-audit';
import { peekProjects } from './project-store';

interface ProjectPolicy extends HandoffSecretSettings { revision: string }
interface PolicyFile { v: 1; projects: Record<string, ProjectPolicy> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function paths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > HANDOFF_SECRET_MAX_PATHS || raw.some((name) => !isSafeHandoffPath(name))
    || new Set(raw).size !== raw.length || Buffer.byteLength(JSON.stringify(raw)) > HANDOFF_SECRET_MAX_SETTING_BYTES) throw new Error('Use bounded, unique, exact relative file paths for handoff exceptions.');
  return [...raw].sort();
}
function parseFile(raw: unknown): PolicyFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid handoff secret settings.');
  const value = raw as PolicyFile;
  if (value.v !== 1 || Object.keys(value).some((key) => !['v', 'projects'].includes(key)) || !value.projects
    || typeof value.projects !== 'object' || Array.isArray(value.projects) || Object.keys(value.projects).length > 1000) throw new Error('Invalid handoff secret settings.');
  for (const [id, policy] of Object.entries(value.projects)) {
    if (!id || id.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(id) || !policy || typeof policy !== 'object'
      || Object.keys(policy).some((key) => !['revision', 'notSecretPaths', 'historyActionIds'].includes(key))
      || !UUID.test(policy.revision) || !Array.isArray(policy.historyActionIds) || policy.historyActionIds.length > 20
      || policy.historyActionIds.some((entry) => typeof entry !== 'string' || !entry.startsWith('handoff-secret:') || entry.length > 256)) throw new Error('Invalid handoff secret settings.');
    paths(policy.notSecretPaths);
  }
  return structuredClone(value);
}

/** Committed-only policy reads: a failed save can never grant an exception. */
class PolicyStore {
  private readonly disk: SettingsStore<PolicyFile>;
  private committed?: PolicyFile;
  private unreadable = false;
  private lock: Promise<unknown> = Promise.resolve();
  constructor() {
    this.disk = createSettingsStore<PolicyFile>('handoff-secret-settings.json', { v: 1, projects: {} }, parseFile, {
      atomic: true, mode: 0o600, rollBackFailedSaves: true,
      onLoad: (result) => {
        if ('error' in result) this.unreadable = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
        else {
          try { parseFile(JSON.parse(result.raw)); }
          catch {
            // telemetry-exempt: access fails closed below, without reflecting raw policy data.
            this.unreadable = true;
          }
        }
      },
    });
  }
  private snapshot(): PolicyFile {
    if (!this.committed) {
      const value = this.disk.get();
      if (this.unreadable) throw new Error('Handoff secret settings are unreadable and have not been overwritten.');
      this.committed = parseFile(value);
    }
    return this.committed;
  }
  get(id: string): ProjectPolicy | undefined {
    const projects = this.snapshot().projects;
    const value = Object.prototype.hasOwnProperty.call(projects, id) ? projects[id] : undefined;
    return value && structuredClone(value);
  }
  set(id: string, update: () => Promise<ProjectPolicy>): Promise<void> {
    const work = async () => {
      const next = structuredClone(this.snapshot());
      next.projects[id] = await update();
      const checked = parseFile(next);
      await this.disk.save(checked);
      this.committed = checked;
    };
    const result = this.lock.then(work, work);
    this.lock = result;
    return result;
  }
}
let singleton: PolicyStore | undefined;
const store = () => singleton ??= new PolicyStore();
async function project(id: string) {
  if (!id || id.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid project.');
  const found = (await peekProjects()).find((entry) => entry.id === id);
  if (!found) throw new Error('Choose a registered project for handoff exceptions.');
  return found;
}
async function receipt(id: string, projectId: string, names: string[], operation: 'confirmation' | 'use'): Promise<void> {
  const { actionsReady, recordExternalRun } = await import('./actions');
  if (!actionsReady()) throw new Error('Action history must be available before a handoff exception can be honored.');
  const at = Date.now();
  await recordExternalRun({
    id, actionId: id, externalSource: 'handoff_secret', owner: { kind: 'user' },
    trigger: { kind: 'manual', at, detail: 'Person-controlled handoff secret exception' }, chain: [], startedAt: at, endedAt: at, outcome: 'done',
    reason: operation === 'confirmation' ? `Person confirmed non-secret paths for project ${safeHandoffDiagnosticPath(projectId)}.` : `Handoff used confirmed non-secret paths for project ${safeHandoffDiagnosticPath(projectId)}.`,
    steps: [{ kind: 'notify', outcome: 'done', detail: names.length ? names.map(safeHandoffDiagnosticPath).join('\n') : 'All handoff secret exceptions removed.' }],
  });
}

export async function getHandoffSecretSettings(projectId: string): Promise<HandoffSecretSettings> {
  await project(projectId);
  const value = store().get(projectId);
  return value ? { notSecretPaths: value.notSecretPaths, historyActionIds: value.historyActionIds } : { notSecretPaths: [], historyActionIds: [] };
}

/** UI IPC is the only writer. Neither MCP grants nor an agent-supplied manifest can authorize this. */
export async function setHandoffSecretSettings(projectId: string, rawPaths: unknown): Promise<HandoffSecretSettings> {
  const origin = currentSettingsOrigin();
  if (origin.surface !== 'ui' || origin.actorId) throw new Error('Only the person can change handoff secret exceptions in project settings.');
  await project(projectId);
  const notSecretPaths = paths(rawPaths);
  await store().set(projectId, async () => {
    const revision = randomUUID();
    const actionId = `handoff-secret:${revision}`;
    // Confirmation is durable before its exception becomes active. A crash
    // between these writes grants nothing that lacks an audit receipt.
    await receipt(actionId, projectId, notSecretPaths, 'confirmation');
    return { revision, notSecretPaths, historyActionIds: [actionId, ...(store().get(projectId)?.historyActionIds ?? [])].slice(0, 20) };
  });
  await auditChanged('project', 'handoff.not_secret_paths', projectId);
  return getHandoffSecretSettings(projectId);
}

const trusted = new WeakSet<object>();
export class HandoffSecretPolicyChanged extends Error {
  constructor() { super('Handoff secret policy changed; check the files again.'); }
}

/** Opaque main-owned policy. All rules still run; only the person's exact confirmed paths can suppress findings. */
export class HandoffSecretPolicy {
  private readonly used = new Set<string>();
  private constructor(readonly projectId: string, private readonly revision: string | undefined, private readonly approved: ReadonlySet<string>) { trusted.add(this); }
  static async forProject(projectId: string): Promise<HandoffSecretPolicy> {
    await project(projectId);
    const current = store().get(projectId);
    return new HandoffSecretPolicy(projectId, current?.revision, new Set(current?.notSecretPaths ?? []));
  }
  assertCurrent(): void {
    if (!trusted.has(this) || store().get(this.projectId)?.revision !== this.revision) throw new HandoffSecretPolicyChanged();
  }
  scan(file: string, content?: Uint8Array): HandoffSecretFinding[] {
    this.assertCurrent();
    const findings = scanHandoffSecrets(file, content);
    if (!findings.length || !this.approved.has(file)) return findings;
    this.used.add(file);
    return [];
  }
  usedPaths(): string[] { return [...this.used].sort().map(safeHandoffDiagnosticPath); }
  async recordUse(handoffId: string, side: 'sender' | 'receiver'): Promise<void> {
    this.assertCurrent();
    if (!this.used.size) return;
    if (!UUID.test(handoffId)) throw new Error('Invalid handoff audit identity.');
    const projectKey = createHash('sha256').update(this.projectId).digest('hex').slice(0, 16);
    const actionId = `handoff-secret:${handoffId}:${side}:${projectKey}:${this.revision}`;
    await receipt(actionId, this.projectId, [...this.used], 'use');
    this.assertCurrent();
    await store().set(this.projectId, async () => {
      this.assertCurrent();
      const current = store().get(this.projectId)!;
      return { ...current, historyActionIds: [actionId, ...current.historyActionIds.filter((id) => id !== actionId)].slice(0, 20) };
    });
    this.assertCurrent();
  }
}
export function isTrustedHandoffSecretPolicy(value: unknown): value is HandoffSecretPolicy { return !!value && typeof value === 'object' && trusted.has(value); }
export function _resetHandoffSecretSettingsForTesting(): void { singleton = undefined; }
